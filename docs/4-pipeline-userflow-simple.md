# Warta Warga 4 Main Userflows

Simple version for generating userflow diagrams.

---

## 1. Validasi Misinformasi / Hoaks

**Goal:** User wants to check whether information is true or fake.

**User input:**
- Text
- Image
- Screenshot
- Link
- Forwarded message

**Flow:**
1. User sends information to AI.
2. AI reads and summarizes the content.
3. AI checks trusted sources or knowledge base.
4. AI decides the result.
5. AI replies with a simple conclusion.

**Output:**
- True / verified
- Hoaks / false
- Not enough information
- Short reason
- Source if available

---

## 2. Laporan Penipuan

**Goal:** User reports a scam or suspicious activity.

**User input:**
- Scam story
- Screenshot
- Image
- Suspicious link
- Proof of scam

**Flow:**
1. User sends scam report.
2. AI reads the report.
3. AI detects scam signs such as transfer request, OTP request, fake link, APK, or fake officer.
4. AI gives safety advice to the user.
5. AI asks for missing details if needed.
6. AI records the report without personal identity.
7. Report goes to admin dashboard.
8. Admin reviews the report.
9. If approved, warning is sent to local groups.

**Output:**
- Safety warning
- What user should do next
- Report recorded
- Waiting for admin review

---

## 3. Pengaduan Internal Warta Warga

**Goal:** User sends a general complaint or issue to Warta Warga admins.

**User input:**
- General complaint
- Community issue
- Information that needs manual review
- Feedback for admins

**Flow:**
1. User sends complaint.
2. AI reads and summarizes it.
3. AI removes or hides personal data.
4. AI asks for missing details if needed.
5. AI sends the complaint to internal dashboard.
6. Admin reviews and follows up manually.

**Output:**
- Complaint received
- Short summary
- Sent to admin dashboard

---

## 4. Lapor Layanan Aduan Masyarakat

**Goal:** User wants to report a public service issue to an official complaint portal.

**User input:**
- Road damage
- Electricity problem
- Water/PDAM problem
- Trash issue
- Public facility issue
- Negative online content
- Image or screenshot

**Flow:**
1. User sends public service complaint.
2. AI reads and summarizes the problem.
3. AI asks for missing location or details.
4. AI shows complaint summary to user.
5. User confirms by replying yes.
6. AI submits the complaint to official portal using automation.
7. Portal returns result.
8. AI sends ticket number or failure message to user.

**Output:**
- Complaint summary
- Confirmation request
- Submitted to official portal
- Ticket number if successful
- Error message if failed

---

# Short Summary

| Pipeline | User Sends | AI Does | Final Output |
| --- | --- | --- | --- |
| Misinformation Validation | Info, image, link, screenshot | Check truth | True / hoaks / unclear |
| Scam Report | Scam story or proof | Warn user and record report | Report to admin dashboard |
| Internal Complaint | General complaint | Summarize and send to admin | Admin review |
| Public Service Complaint | Service issue | Submit to official portal | Ticket number |
