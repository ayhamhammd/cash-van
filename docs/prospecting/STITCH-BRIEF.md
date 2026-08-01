# Stitch Design Brief — "Lead Finder" (العملاء المحتملون) for VanFlow Dashboard

Copy-paste the sections below into Stitch. It describes 3 screens for a new feature inside an
existing dark, Arabic-first (RTL) field-sales dashboard called VanFlow.

---

## Design system (must match exactly)

**Theme: dark-first.**
- Page background `#0a0c0f`, secondary bg `#111318`, tertiary `#181c24`
- Cards/surfaces `#1e2330`, raised surface `#252a38`, highest `#2d3346`
- Text: primary `#f0f2f8`, muted `#8a91a8`, faint `#4a5068`
- **Accent (brand): `#00ffc8`** (neon mint-teal), pressed `#00cc9f`, tint `rgba(0,255,200,0.15)`
- Semantic: green `#22c97b` (ok/converted), amber `#f5a623` (pending/quoted), red `#f25c5c`
  (rejected/overdue), purple `#9b7fea`, teal `#2dd4bf`; each has a 15%-alpha tinted badge bg
- AI family (only for AI hints): cyan `#06b6d4`, gradient `#00ffc8 → #0047ab`

**Type:** Arabic-first — Tajawal for Arabic (the primary language, RTL), Plus Jakarta Sans for
Latin, IBM Plex Mono for all numbers/IDs/phone numbers (numbers stay LTR inside RTL text).

**Shape:** rounded corners (8–16px radii), soft large-radius cards, subtle borders
(`#252a38`-ish), no heavy shadows. Buttons: primary = accent bg with dark text; secondary =
surface bg with border; small pill badges with tinted backgrounds and colored dots.

**Layout:** RTL. Sidebar navigation exists on the right; content area with a PageHeader
(title + subtitle + action buttons) on top. Tables have a toolbar with a search input.

---

## Screen 1 — Prospecting map search (البحث عن عملاء محتملين)

Split layout (RTL): **map takes ~60%** of the width, results panel ~40%.

- Map: dark-styled Google Map. The user taps a point → a glowing accent (`#00ffc8`) pin drops
  with a translucent accent radius circle around it. A floating control card (top of map, glass
  dark surface) holds: radius slider (200م — 5كم, value shown in mono), category chips
  (multi-select pills: سوبرماركت، بقالة، مول، ميني ماركت), and a primary accent button "ابحث".
- Results panel: list of found businesses as compact rows — name (Tajawal, bold), category +
  distance ("سوبرماركت · 350م" muted), phone in mono (or a subtle "بدون هاتف" badge), rating
  stars (small, amber), and a status badge. Rows for businesses that are ALREADY customers
  render dimmed with a neutral badge "زبون حالي" and sit under a collapsed divider.
- Top of panel: count summary "وجدنا 34 محلًا — 9 زبائن حاليين، 25 جديد" + a filter toggle
  (الكل / جديد فقط).
- Empty state: illustration-free, centered muted text "اختر نقطة على الخريطة وحدد النطاق ثم اضغط ابحث".

## Screen 2 — Prospect list & outreach (قائمة العملاء المحتملين)

Full-width data table (dark, same style as the rest of the dashboard):

- Columns: الاسم · التصنيف · المسافة · الهاتف (mono) · الحالة · أُرسل في · إجراءات
- Status badges: جديد (accent tint) · تم الإرسال (amber tint) · تم التواصل (teal tint) ·
  تحوّل لزبون (green tint) · مرفوض (red tint)
- Row actions: a WhatsApp send icon-button (accent), and an overflow menu (تحويل إلى زبون،
  ملاحظات، حذف).
- Clicking a row opens a right→left Drawer: business details, mini map, notes textarea, a
  status timeline (vertical, dots colored by status), and two buttons — primary
  "إرسال عرض السعر عبر واتساب" and secondary "تحويل إلى زبون".
- KPI strip above the table (4 stat tiles, mono numbers): محتملون جدد · أُرسل لهم ·
  فتحوا العرض · تحوّلوا لزبائن.

## Screen 3 — Quote template builder (قالب عرض السعر)

Two-column editor (RTL) with a live preview:

- Right column (form): logo upload dropzone (square, dashed border) · company description
  textarea · contact phones (repeatable mono inputs) · WhatsApp message textarea with a hint
  "هذه الرسالة سترافق رابط العرض" · a searchable product picker (search input + checkbox list)
  where each selected product shows an **editable price field** (mono, JOD).
- Left column (preview): a live A4-ish preview card of the quote page — logo on top, company
  name + description, a clean product/price table, offers note, phone numbers footer. The
  preview uses a LIGHT surface (like paper, `#ffffff` with dark text) contrasting with the
  dark app around it.
- Footer bar: secondary "معاينة كاملة" + primary accent "حفظ القالب".

---

Tone: professional field-sales tool, dense but breathable; Arabic copy everywhere with mono
numerals; accent `#00ffc8` used sparingly (primary actions, active pins, key highlights) so it
pops against the dark surfaces.
