import { config } from '../config.js';

function getSolverConfig() {
  const { cloudflareCaptcha } = config;
  const selectedProvider = cloudflareCaptcha.provider || "gemini";

  console.log(`[Solver-Config] Provider selected: ${selectedProvider}`);
  console.log(`[Solver-Config] OpenRouter Key available: ${cloudflareCaptcha.openrouterApiKey ? 'Yes' : 'No'}`);
  console.log(`[Solver-Config] Gemini Key available: ${cloudflareCaptcha.geminiApiKey ? 'Yes' : 'No'}`);

  return {
    enabled: cloudflareCaptcha.enabled,
    provider: selectedProvider,
    geminiApiKey: cloudflareCaptcha.geminiApiKey,
    geminiModel: cloudflareCaptcha.geminiModel,
    openrouterApiKey: cloudflareCaptcha.openrouterApiKey,
    openrouterModel: cloudflareCaptcha.openrouterModel,
    maxRetries: cloudflareCaptcha.maxRetries,
    challengeTimeoutMs: cloudflareCaptcha.challengeTimeoutMs,
  };
}

async function detectCloudflareChallenge(page) {
    const turnstileIframe = await page.locator('iframe[src*="challenges.cloudflare.com/turnstile"]');
    for (let i = 0; i < await turnstileIframe.count(); i++) {
        const iframe = turnstileIframe.nth(i);
        if (await iframe.isVisible().catch(() => false)) {
            return { type: 'turnstile', iframe };
        }
    }

    const imageChallengeIframe = await page.locator('iframe[src*="challenges.cloudflare.com"]');
    for (let i = 0; i < await imageChallengeIframe.count(); i++) {
        const iframe = imageChallengeIframe.nth(i);
        if (await iframe.isVisible().catch(() => false)) {
            return { type: 'image', iframe };
        }
    }

    const bodyText = await page.locator("body").textContent().catch(() => "");
    if (/Just a moment|Checking your browser|Verifikasi keamanan/i.test(bodyText || "")) {
        return { type: 'managed' };
    }

    return null;
}

async function solveTurnstile(page, iframe) {
    try {
        const box = await iframe.boundingBox();
        if (box) {
            const x = box.x + 30;
            const y = box.y + box.height / 2;
            await page.mouse.click(x, y);
            return true;
        }
    } catch (e) {
        // ignore
    }
    return false;
}

async function callVisionApi(imageBuffer) {
    const solverConfig = getSolverConfig();
    let endpoint, apiKey, model, headers = { "Content-Type": "application/json" };

    if (solverConfig.provider === 'openrouter') {
        endpoint = "https://openrouter.ai/api/v1/chat/completions";
        apiKey = solverConfig.openrouterApiKey;
        model = solverConfig.openrouterModel;
        headers["HTTP-Referer"] = config.openrouter.appUrl;
        headers["X-Title"] = config.openrouter.appName;
    } else { // default to gemini
        endpoint = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
        apiKey = solverConfig.geminiApiKey;
        model = solverConfig.geminiModel;
    }

    if (!apiKey) {
        throw new Error(`API key for ${solverConfig.provider} is not configured.`);
    }

    const messages = [
        {
            role: "system",
            content: `You are a precise Cloudflare CAPTCHA solver. The user will provide an image of a CAPTCHA challenge. Your task is to first read the instruction from the image, then identify the coordinates of the centers of the images to be clicked that match that instruction. The top-left corner of the image is (0, 0). Respond with a JSON object containing a key 'clicks' which is an array of objects, each with 'x' and 'y' coordinates. Example: {\"clicks\": [{\"x\": 123, \"y\": 45}, {\"x\": 200, \"y\": 50}]}`
        },
        {
            role: "user",
            content: [
                { type: "text", text: "Analyze the CAPTCHA image, find the instruction, and provide the coordinates of the centers of the items to click." },
                {
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString("base64")}` }
                }
            ]
        }
    ];

    const body = { model, messages, temperature: 0, max_tokens: 300, response_format: { type: "json_object" } };

    const res = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        throw new Error(`Vision API request failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const responseText = data?.choices?.[0]?.message?.content;
    if (!responseText) {
        throw new Error("Vision API returned an empty response.");
    }

    try {
        const parsed = JSON.parse(responseText);
        if (Array.isArray(parsed?.clicks)) {
            return parsed.clicks;
        }
    } catch (e) {
        throw new Error(`Failed to parse Vision API response as JSON: ${responseText}`);
    }

    throw new Error(`Unexpected Vision API response format: ${responseText}`);
}

async function solveImageChallenge(page, iframe) {
    const frame = await iframe.contentFrame();
    if (!frame) throw new Error("Could not get content frame from Cloudflare challenge iframe.");

    await page.waitForTimeout(4000); // Give frame time to load and animations to run.

    const challengeBox = await iframe.boundingBox();
    if (!challengeBox) throw new Error("Could not get bounding box of challenge iframe.");

    const imageBuffer = await iframe.screenshot();

    console.log(`[cloudflare-captcha-solver] Screenshotting challenge iframe. Sending to Vision API.`);

    const clicks = await callVisionApi(imageBuffer);
    console.log(`[cloudflare-captcha-solver] Vision API suggests clicking ${clicks.length} points.`);

    for (const click of clicks) {
        const absoluteX = challengeBox.x + click.x;
        const absoluteY = challengeBox.y + click.y;
        console.log(`[cloudflare-captcha-solver] Clicking at (${absoluteX.toFixed(2)}, ${absoluteY.toFixed(2)})`);
        await page.mouse.click(absoluteX, absoluteY);
        await page.waitForTimeout(500 + Math.random() * 500);
    }

    const verifyButtonLocator = frame.locator('button[type="submit"], input[type="button"][value="Verify"]');
    if (await verifyButtonLocator.count() > 0) {
        console.log("[cloudflare-captcha-solver] Clicking verify button.");
        await verifyButtonLocator.first().click();
    }

    return true;
}

async function hasClearanceCookie(page) {
    return (await page.context().cookies()).some(c => c.name === 'cf_clearance' && /aduankonten\.id$/i.test(c.domain || ''));
}

export async function solveCloudflareChallenge(page) {
    const solverConfig = getSolverConfig();
    if (!solverConfig.enabled) return false;

    for (let i = 0; i < solverConfig.maxRetries; i++) {
        try {
            await page.waitForTimeout(3000);
            const challenge = await detectCloudflareChallenge(page);

            if (!challenge) return true;

            console.log(`[cloudflare-captcha-solver] Detected Cloudflare challenge: ${challenge.type}`);
            let solved = false;
            if (challenge.type === 'turnstile') {
                solved = await solveTurnstile(page, challenge.iframe);
            } else if (challenge.type === 'image') {
                solved = await solveImageChallenge(page, challenge.iframe);
            } else if (challenge.type === 'managed') {
                await page.waitForTimeout(5000);
                continue;
            }

            if (solved) {
                console.log("[cloudflare-captcha-solver] Challenge interaction complete, waiting for clearance and navigation...");
                try {
                    await challenge.iframe.waitFor({ state: 'hidden', timeout: 20000 });
                } catch (e) {
                    console.warn("[cloudflare-captcha-solver] Timed out waiting for challenge to disappear, but will proceed.");
                }

                await page.waitForTimeout(3000);
                const hasClearance = await hasClearanceCookie(page);
                const remainingChallenge = await detectCloudflareChallenge(page);
                if (hasClearance && !remainingChallenge) {
                    console.log("[cloudflare-captcha-solver] Successfully obtained cookie and challenge is gone.");
                    return true;
                }

                if (hasClearance && remainingChallenge) {
                    console.log("[cloudflare-captcha-solver] Clearance cookie exists, but challenge is still visible. Retrying without reporting success.");
                } else {
                    console.log("[cloudflare-captcha-solver] Challenge may be gone, but no clearance cookie found. Retrying.");
                }
            }
        } catch (error) {
            console.error(`[cloudflare-captcha-solver] Attempt ${i + 1} failed: ${error.message}`);
            if (i === solverConfig.maxRetries - 1) throw error;
        }
    }

    throw new Error("Failed to solve Cloudflare challenge after multiple retries.");
}
