import { startAduanKontenChecker } from "./aduankonten-checker.js";
import { startLaporgubChecker } from "./laporgub-checker.js";

let _started = false;

export function startAgent2ServiceCheckers() {
  if ((process.env.AGENT2_LAYANAN_CHECKERS_ENABLED ?? "true") === "false") {
    console.log("[agent2-checker] scheduler layanan dinonaktifkan.");
    return;
  }
  if (_started) return;
  _started = true;
  startLaporgubChecker();
  startAduanKontenChecker();
}
