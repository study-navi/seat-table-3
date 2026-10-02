/* ==========================================================
   複数教室に展開するための仕組み。
   新しい教室のページは、このapp.js/style.cssを直接読み込みつつ、
   自分のindex.html側で window.__seatStorageOverride 等を
   先に定義しておくことで、保存先や合言葉の区別を上書きできる。
   何も上書きしなければ、これまで通りの動作（柊山校・共和校）。
   ========================================================== */
var STORAGE = window.__seatStorageOverride || window.localStorage;
var SESSION_STORAGE = window.__seatSessionStorageOverride || window.sessionStorage;
/* =========================================================
座席表アプリ本体
- localStorage キー "seat-table-v1" は旧サイトと同じ構造を維持
（旧サイトからエクスポートしたバックアップJSONをそのまま読み込めるようにするため）
========================================================= */

const STORAGE_KEY = "seat-table-v1";
/* 教室識別子。他教室のindex.htmlでは window.__seatClassroomId で上書きする。 */
const CLASSROOM_ID = window.__seatClassroomId || "seat-table-classroom-1";
const GOOGLE_BACKUP_CFG_KEY = "seat-table-google-backup";
const GOOGLE_BACKUP_STATUS_KEY = "seat-table-google-backup-status";

const WEEKDAY_LABELS = ["日","月","火","水","木","金","土"];

const DEFAULT_SUBJECTS = [
"国語","算数","数学","英語","理科","社会",
"物理","化学","生物","地学",
"現代文","古文","漢文",
"日本史","世界史","地理","公民",
"情報","小論文",
"数学Ⅰ","数学A","物理基礎","化学基礎",
"その他"
];

const COMMON_TIME_PRESETS = [
"09:00〜10:30","10:40〜12:10","13:00〜14:30","14:40〜16:10",
"16:40〜18:10","18:20〜19:50","20:00〜21:30"
];

const STATUS_LABELS = { course: "講習", transfer: "振替", absent: "欠席" };

/* ---------------- state ---------------- */
let state = null;
let currentDate = todayStr();
let currentTab = "seat";
let studentSearch = "";
let teacherWarnCache = new Set(); // teacher names currently in use somewhere
let historyView = null; // 過去の座席表表示中 { snapshotState, savedAt, kind, fileId, targetDate, fileName }

function todayStr(){
const d = new Date();
return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate());
}
function pad(n){ return String(n).padStart(2,"0"); }
function uid(){ return Math.random().toString(36).slice(2,9); }

/* ---------------- persistence ---------------- */
function loadState(){
let raw = null;
try{ raw = STORAGE.getItem(STORAGE_KEY); }catch(e){}
let data;
try{ data = raw ? JSON.parse(raw) : null; }catch(e){ data = null; }
data = migrate(data || {});
return data;
}

function migrate(data){
data.students = Array.isArray(data.students) ? data.students : [];
data.teachers = Array.isArray(data.teachers) ? data.teachers : [];
data.days = (data.days && typeof data.days === "object") ? data.days : {};
data.weekdayPresets = (data.weekdayPresets && typeof data.weekdayPresets === "object") ? data.weekdayPresets : {};
data.customSubjects = Array.isArray(data.customSubjects) ? data.customSubjects : [];
data.printSettings = (data.printSettings && typeof data.printSettings === "object") ? data.printSettings : {};
data.printSettings.subjectSize = data.printSettings.subjectSize || 15;
data.printSettings.studentSize = data.printSettings.studentSize || 10.5;
data.printSettings.gradeSize = data.printSettings.gradeSize || 7.5;
if(!Array.isArray(data.printSettings.images)){
data.printSettings.images = [];
if(data.printSettings.logoImage){
data.printSettings.images.push({
id: uid(), src: data.printSettings.logoImage,
xPct: data.printSettings.logoMode==="corner-tl" ? 2 : (data.printSettings.logoMode==="watermark" ? 30 : 85),
yPct: 2, widthPct: data.printSettings.logoMode==="watermark" ? 40 : 12,
opacity: (typeof data.printSettings.logoOpacity === "number") ? data.printSettings.logoOpacity : 0.18
});
}
}
delete data.printSettings.logoImage;
delete data.printSettings.logoMode;
delete data.printSettings.logoOpacity;
// normalize students
data.students.forEach(s=>{
if(!s.id) s.id = uid();
s.name = s.name || "";
s.birthdate = s.birthdate || "";
s.grade = s.grade || "";
s.subject = s.subject || "";
});
// normalize teachers
data.teachers.forEach(t=>{
if(!t.id) t.id = uid();
t.name = t.name || "";
t.subjects = t.subjects || "";
t.note = t.note || "";
});
// normalize days / presets blocks
const fixDay = (day)=>{
if(!day || typeof day !== "object") day = {};
day.blocks = Array.isArray(day.blocks) ? day.blocks : [];
day.blocks.forEach(b=>{
if(!b.id) b.id = uid();
b.time = b.time || "時間を入力";
b.seats = Array.isArray(b.seats) ? b.seats : [];
b.groupRows = Array.isArray(b.groupRows) ? b.groupRows : [];
b.seats.forEach((s,i)=>{
s.seatNumber = (s.seatNumber !== undefined && s.seatNumber !== null && s.seatNumber !== "") ? String(s.seatNumber) : String(i+1);
s.teacher = s.teacher || "";
s.left = s.left || {student:"",subject:"",grade:"",status:"normal"};
s.right = s.right || {student:"",subject:"",grade:"",status:"normal"};
s.left.status = s.left.status || "normal";
s.right.status = s.right.status || "normal";
});
b.groupRows.forEach(g=>{
if(!g.id) g.id = uid();
g.seatNumber = g.seatNumber || "";
g.name = g.name || "";
g.teacher = g.teacher || "";
g.subject = g.subject || "";
g.students = Array.isArray(g.students) ? g.students : [];
});
});
return day;
};
Object.keys(data.days).forEach(k=> data.days[k] = fixDay(data.days[k]));
Object.keys(data.weekdayPresets).forEach(k=> data.weekdayPresets[k] = fixDay(data.weekdayPresets[k]));
return data;
}

let saveTimer = null;
function saveState(){
if(historyView) return;
setSaveIndicator("saving");
try{
STORAGE.setItem(STORAGE_KEY, JSON.stringify(state));
clearTimeout(saveTimer);
saveTimer = setTimeout(()=> applyGoogleBackupUi(), 250);
scheduleGoogleBackup();
}catch(e){
setSaveIndicator("error");
showToast("保存に失敗しました（ブラウザのストレージ容量を確認してください）", true);
}
}
function getLiveState(){ return state; }
function getDisplayState(){ return historyView ? historyView.snapshotState : state; }
function isHistoryView(){ return !!historyView; }
function setSaveIndicator(mode, customText){
const el = document.getElementById("saveIndicator");
const text = document.getElementById("saveIndicatorText");
if(!el || !text) return;
el.classList.remove("saving","error");
if(mode==="saving"){ el.classList.add("saving"); text.textContent = customText || "保存中…"; }
else if(mode==="error"){ el.classList.add("error"); text.textContent = customText || "保存に失敗しました"; }
else{ text.textContent = customText || (getGoogleBackupConfig() && loadGoogleBackupStatus().phase === "ok" ? "Googleに履歴保存済み" : "この端末に自動保存"); }
}

/* =========================================================
Google自動バックアップ（端末内保存の追加の安全対策）
生徒名などの中身は画面・URL・consoleに出さない。
========================================================= */
let googleBackupTimer = null;
let googleBackupInFlight = false;
let googleBackupAgain = false;

function getGoogleBackupConfig(){
let raw = null;
try{ raw = STORAGE.getItem(GOOGLE_BACKUP_CFG_KEY); }catch(e){ return null; }
if(!raw) return null;
try{
const cfg = JSON.parse(raw);
const url = String(cfg && cfg.webAppUrl ? cfg.webAppUrl : "").trim();
const token = String(cfg && cfg.token ? cfg.token : "");
if(!url || !token) return null;
if(cfg.classroomId && cfg.classroomId !== CLASSROOM_ID) return null;
return { webAppUrl: url, token: token };
}catch(e){ return null; }
}
function saveGoogleBackupConfig(webAppUrl, token){
STORAGE.setItem(GOOGLE_BACKUP_CFG_KEY, JSON.stringify({
classroomId: CLASSROOM_ID,
webAppUrl: String(webAppUrl || "").trim(),
token: String(token || "")
}));
}
function loadGoogleBackupStatus(){
let raw = null;
try{ raw = STORAGE.getItem(GOOGLE_BACKUP_STATUS_KEY); }catch(e){}
if(!raw) return { phase: getGoogleBackupConfig() ? "ok" : "unset", lastOkAt: "", lastError: "", lastFileName: "" };
try{
const s = JSON.parse(raw);
return {
phase: s.phase || (getGoogleBackupConfig() ? "ok" : "unset"),
lastOkAt: s.lastOkAt || "",
lastError: s.lastError || "",
lastFileName: s.lastFileName || ""
};
}catch(e){
return { phase: "unset", lastOkAt: "", lastError: "", lastFileName: "" };
}
}
function persistGoogleBackupStatus(s){
try{ STORAGE.setItem(GOOGLE_BACKUP_STATUS_KEY, JSON.stringify({
phase: s.phase,
lastOkAt: s.lastOkAt || "",
lastError: s.lastError || "",
lastFileName: s.lastFileName || ""
})); }catch(e){}
}
function formatBackupTime(iso){
if(!iso) return "—";
const d = new Date(iso);
if(isNaN(d.getTime())) return "—";
const p = n=> String(n).padStart(2,"0");
return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function googleErrorMessage(code){
const map = {
unauthorized: "教室IDまたは合言葉が正しくありません。",
classroom_mismatch: "このWebアプリは別の教室用です。URLを確認してください。",
not_setup: "Google側の初回セットアップがまだです。",
invalid_payload: "バックアップデータの形式が正しくありません。",
no_backup: "Google側にまだ履歴がありません。",
not_found: "指定の履歴が見つかりません。",
bad_response: "Googleからの応答を読めませんでした。",
failed: "Googleへの保存に失敗しました。",
server_error: "Google側でエラーが起きました。",
offline: "ネット未接続のためGoogleへ保存できませんでした。"
};
return map[code] || "Googleへの保存に失敗しました。";
}
function postGoogleBackupApi(action, extra){
const cfg = getGoogleBackupConfig();
if(!cfg) return Promise.reject(new Error("unset"));
if(typeof navigator !== "undefined" && navigator.onLine === false){
return Promise.reject(new Error("offline"));
}
const body = {
action: action,
classroomId: CLASSROOM_ID,
token: cfg.token
};
if(action === "backup" || action === "finalizeLesson"){
let snapshot = extra && extra.json;
if(!snapshot){
try{ snapshot = JSON.parse(STORAGE.getItem(STORAGE_KEY)); }catch(e){ snapshot = null; }
}
if(!snapshot || typeof snapshot !== "object") snapshot = getLiveState();
body.json = snapshot;
body.targetDate = (extra && extra.targetDate) || currentDate;
}
if(action === "snapshot"){
body.fileId = extra && extra.fileId;
if(!body.fileId) return Promise.reject(new Error("invalid_payload"));
}
return fetch(cfg.webAppUrl, {
method: "POST",
headers: { "Content-Type": "text/plain;charset=utf-8" },
body: JSON.stringify(body)
}).then(res=>{
return res.text().then(text=>{
let data = null;
try{ data = JSON.parse(text); }catch(e){ throw new Error("bad_response"); }
if(!data || !data.ok) throw new Error((data && data.error) || "failed");
if(data.classroomId && data.classroomId !== CLASSROOM_ID) throw new Error("classroom_mismatch");
return data;
});
});
}
function applyGoogleBackupUi(){
const s = loadGoogleBackupStatus();
if(googleBackupInFlight) s.phase = "saving";
if(!getGoogleBackupConfig()){
if(!googleBackupInFlight) setSaveIndicator("ok", "この端末に自動保存");
}else if(s.phase === "saving"){
setSaveIndicator("saving", "Googleへバックアップ中…");
}else if(s.phase === "error"){
setSaveIndicator("error", "Googleバックアップ失敗");
}else if(s.phase === "ok"){
setSaveIndicator("ok", "Googleに履歴保存済み");
}
const box = document.getElementById("googleBackupStatusBox");
if(!box) return;
box.innerHTML = googleBackupStatusHtml(s);
}
function googleBackupStatusHtml(s){
const configured = !!getGoogleBackupConfig();
const phase = !configured ? "unset" : (googleBackupInFlight ? "saving" : s.phase);
let err = "";
if(configured && phase === "error" && s.lastError) err = `<p class="google-backup-error">${escapeHtml(googleErrorMessage(s.lastError))}</p>`;
return `
<p><strong>現在の状態：</strong>${escapeHtml(
phase === "unset" ? "未設定" :
phase === "saving" ? "バックアップ中" :
phase === "error" ? "エラー" :
(s.lastOkAt ? "Googleに履歴保存済み" : "設定済み（まだ履歴なし）")
)}</p>
<p><strong>最終保存日時：</strong>${escapeHtml(formatBackupTime(s.lastOkAt))}</p>
${err}
`;
}
function scheduleGoogleBackup(){
if(!getGoogleBackupConfig()) return;
clearTimeout(googleBackupTimer);
googleBackupTimer = setTimeout(()=> runGoogleBackup(false), 1500);
}
function runGoogleBackup(urgent){
if(!getGoogleBackupConfig()) return Promise.resolve();
clearTimeout(googleBackupTimer);
if(googleBackupInFlight){
googleBackupAgain = true;
return Promise.resolve();
}
googleBackupInFlight = true;
googleBackupAgain = false;
const prev = loadGoogleBackupStatus();
persistGoogleBackupStatus(Object.assign({}, prev, { phase: "saving" }));
applyGoogleBackupUi();
return postGoogleBackupApi("backup", { json: getLiveState(), targetDate: currentDate }).then(data=>{
persistGoogleBackupStatus({
phase: "ok",
lastOkAt: data.updatedAt || new Date().toISOString(),
lastError: "",
lastFileName: data.fileName || ""
});
}).catch(err=>{
const code = (err && err.message) ? String(err.message) : "failed";
persistGoogleBackupStatus({
phase: "error",
lastOkAt: prev.lastOkAt || "",
lastError: code,
lastFileName: prev.lastFileName || ""
});
}).finally(()=>{
googleBackupInFlight = false;
applyGoogleBackupUi();
if(googleBackupAgain){
googleBackupAgain = false;
scheduleGoogleBackup();
}
});
}
function confirmThenBackup(message, onConfirm){
confirmDialog(message, ()=>{
const go = ()=>{ try{ onConfirm(); }catch(e){} };
if(!getGoogleBackupConfig()){ go(); return; }
showToast("削除前にGoogleへバックアップしています…");
runGoogleBackup(true).then(go, go);
});
}
function dayStats(day){
const blocks = (day && day.blocks) || [];
let groups = 0, seats = 0;
blocks.forEach(b=>{
seats += (b.seats || []).length;
groups += (b.groupRows || []).length;
});
return { blocks: blocks.length, seats, groups };
}

function getOrCreateDay(dateStr){
if(historyView){
const d = historyView.snapshotState.days && historyView.snapshotState.days[dateStr];
return d || { blocks: [] };
}
if(!state.days[dateStr]){
state.days[dateStr] = { blocks: COMMON_TIME_PRESETS.map(()=>emptyBlock()) };
}
return state.days[dateStr];
}
function historyKindLabel(kind){
return kind === "finalized" ? "保存した授業" : "自動保存";
}
function formatHistorySavedAt(iso){
return formatBackupTime(iso);
}
function formatHistoryDateLabel(dateStr){
if(!dateStr) return "日付不明";
const [y,m,d] = dateStr.split("-").map(Number);
if(!y) return dateStr;
const wd = weekdayOf(dateStr);
return `${y}年${m}月${d}日（${WEEKDAY_LABELS[wd]}）`;
}
function summarizeDayBlocks(day){
const blocks = (day && day.blocks) || [];
return blocks.map(block=>{
const students = new Set();
let mainSubject = "";
let mainTeacher = "";
(block.seats || []).forEach(seat=>{
if(seat.teacher && !mainTeacher) mainTeacher = seat.teacher;
["left","right"].forEach(side=>{
const cell = seat[side] || {};
if(cell.student) students.add(cell.student);
if(cell.subject && !mainSubject) mainSubject = cell.subject;
});
});
(block.groupRows || []).forEach(g=>{
if(g.teacher && !mainTeacher) mainTeacher = g.teacher;
if(g.subject && !mainSubject) mainSubject = g.subject;
(g.students || []).forEach(n=>{ if(n) students.add(n); });
});
return {
time: block.time || "時間未設定",
subject: mainSubject || "—",
teacher: mainTeacher || "—",
studentCount: students.size
};
}).filter(row=> row.studentCount > 0 || (row.time && row.time !== "時間を入力"));
}
function groupHistoryItems(items){
const map = {};
(items || []).forEach(item=>{
const key = item.targetDate || "unknown";
if(!map[key]) map[key] = { targetDate: key, items: [], finalizedAt: "" };
map[key].items.push(item);
if(item.kind === "finalized"){
const cur = map[key].finalizedAt;
if(!cur || String(item.savedAt) > cur) map[key].finalizedAt = item.savedAt;
}
});
return Object.values(map).sort((a,b)=> String(b.targetDate).localeCompare(String(a.targetDate)));
}
function updateHistoryBanner(){
let bar = document.getElementById("historyViewBanner");
if(!historyView){
if(bar) bar.remove();
document.body.classList.remove("history-view-mode");
return;
}
document.body.classList.add("history-view-mode");
if(!bar){
bar = document.createElement("div");
bar.id = "historyViewBanner";
bar.className = "history-view-banner";
document.body.appendChild(bar);
}
const label = formatHistoryDateLabel(historyView.targetDate || currentDate);
const timeLabel = formatHistorySavedAt(historyView.savedAt);
bar.innerHTML = `
<div class="history-view-banner-inner">
<span class="history-view-banner-text">過去の座席表を表示中：${escapeHtml(label)} ${escapeHtml(timeLabel)}（${escapeHtml(historyKindLabel(historyView.kind))}）</span>
<div class="history-view-banner-actions">
<button type="button" class="btn" id="btnHistoryBackToNow">現在に戻る</button>
<button type="button" class="btn primary" id="btnHistoryRestorePoint">この時点に復元</button>
</div>
</div>`;
bar.querySelector("#btnHistoryBackToNow").addEventListener("click", exitHistoryView);
bar.querySelector("#btnHistoryRestorePoint").addEventListener("click", restoreFromHistoryPoint);
}
function exitHistoryView(){
historyView = null;
updateHistoryBanner();
if(currentTab === "seat") renderSeatView();
else renderCurrentView();
showToast("現在の座席表に戻りました");
}
function restoreFromHistoryPoint(){
if(!historyView) return;
const label = formatHistorySavedAt(historyView.savedAt);
confirmDialog(`この履歴（${label}）の時点に座席表を復元します。現在のデータは履歴として保存したうえで置き換えます。よろしいですか？`, ()=>{
if(!getGoogleBackupConfig()){
showToast("先にGoogle連携を設定してください", true);
return;
}
const snap = historyView.snapshotState;
const restoreDate = historyView.targetDate;
showToast("現在のデータを履歴保存してから復元しています…");
runGoogleBackup(true).then(()=>{
state = migrate(JSON.parse(JSON.stringify(snap)));
historyView = null;
updateHistoryBanner();
if(restoreDate) currentDate = restoreDate;
saveState();
renderTabs();
renderCurrentView();
showToast("履歴の時点に復元しました");
}, ()=>{
state = migrate(JSON.parse(JSON.stringify(snap)));
historyView = null;
updateHistoryBanner();
if(restoreDate) currentDate = restoreDate;
saveState();
renderTabs();
renderCurrentView();
showToast("履歴の時点に復元しました（履歴保存はスキップ）");
});
});
}
function openHistorySnapshot(fileId){
if(!fileId) return;
showToast("履歴を読み込んでいます…");
postGoogleBackupApi("snapshot", { fileId }).then(data=>{
if(data.classroomId && data.classroomId !== CLASSROOM_ID){
showToast("別教室の履歴は表示できません", true);
return;
}
if(!data.json || typeof data.json !== "object"){
showToast("履歴データが空でした", true);
return;
}
historyView = {
fileId: data.fileId,
fileName: data.fileName || "",
savedAt: data.savedAt || "",
kind: data.kind || "auto",
targetDate: data.targetDate || currentDate,
snapshotState: migrate(JSON.parse(JSON.stringify(data.json)))
};
if(historyView.targetDate) currentDate = historyView.targetDate;
closeModal();
currentTab = "seat";
renderTabs();
renderSeatView();
updateHistoryBanner();
}).catch(err=>{
showToast(googleErrorMessage(err && err.message), true);
});
}
function openLessonHistoryModal(){
if(!getGoogleBackupConfig()){
showToast("先に「設定・バックアップ」でGoogle連携を設定してください", true);
return;
}
openModal(`
<h3>授業履歴</h3>
<p class="sub">Googleに保存された座席表の履歴です。日付を選んで「表示する」で、その時点の座席表を開けます。</p>
<div id="lessonHistoryLoading" class="history-loading">履歴を読み込んでいます…</div>
<div id="lessonHistoryList" class="history-list" hidden></div>
<div class="modal-actions">
<button class="btn" id="modalCancel">閉じる</button>
</div>
`, (modal)=>{
modal.querySelector("#modalCancel").addEventListener("click", closeModal);
postGoogleBackupApi("history").then(data=>{
if(data.classroomId && data.classroomId !== CLASSROOM_ID){
modal.querySelector("#lessonHistoryLoading").textContent = "別教室の履歴です。";
return;
}
const groups = groupHistoryItems(data.items || []);
const listEl = modal.querySelector("#lessonHistoryList");
const loadEl = modal.querySelector("#lessonHistoryLoading");
if(!groups.length){
loadEl.textContent = "まだ履歴がありません。座席表を編集するか『この授業を保存』を押すと保存されます。";
return;
}
return Promise.all(groups.map(group=>{
const top = group.items[0];
if(!top || !top.fileId || group.targetDate === "unknown") return Promise.resolve(group);
return postGoogleBackupApi("snapshot", { fileId: top.fileId }).then(snap=>{
if(snap.classroomId && snap.classroomId !== CLASSROOM_ID) return group;
const td = snap.targetDate || group.targetDate;
const day = snap.json && snap.json.days && td ? snap.json.days[td] : null;
group.previewBlocks = summarizeDayBlocks(day);
return group;
}).catch(()=> group);
})).then(filledGroups=>{
loadEl.hidden = true;
listEl.hidden = false;
listEl.innerHTML = filledGroups.map(group=>{
const dateLabel = group.targetDate === "unknown" ? "日付不明" : formatHistoryDateLabel(group.targetDate);
const blockLines = (group.previewBlocks || []).map(row=>
`<li>${escapeHtml(row.time)}　${escapeHtml(row.subject)}　講師：${escapeHtml(row.teacher)}　生徒${row.studentCount}名</li>`
).join("");
const finalizedLine = group.finalizedAt
? `<p class="history-finalized-note">この授業を保存：${escapeHtml(formatHistorySavedAt(group.finalizedAt))}に保存済み</p>`
: "";
const entriesHtml = group.items.map(item=>{
const kind = historyKindLabel(item.kind);
const saved = formatHistorySavedAt(item.savedAt);
return `<div class="history-entry">
<div class="history-entry-head">
<span class="history-kind ${item.kind === "finalized" ? "finalized" : "auto"}">${escapeHtml(kind)}</span>
<span class="history-saved-at">${escapeHtml(saved)}</span>
</div>
<button type="button" class="btn primary js-open-history" data-file-id="${escapeHtml(item.fileId)}">表示する</button>
</div>`;
}).join("");
return `<section class="history-day-group">
<h4>${escapeHtml(dateLabel)}</h4>
${blockLines ? `<ul class="history-day-summary">${blockLines}</ul>` : ""}
${finalizedLine}
<div class="history-entries">${entriesHtml}</div>
</section>`;
}).join("");
listEl.querySelectorAll(".js-open-history").forEach(btn=>{
btn.addEventListener("click", ()=> openHistorySnapshot(btn.dataset.fileId));
});
});
}).catch(err=>{
modal.querySelector("#lessonHistoryLoading").textContent = googleErrorMessage(err && err.message);
});
});
}
function finalizeCurrentLesson(){
if(historyView){ showToast("過去表示中は保存できません。「現在に戻る」を押してください。", true); return; }
if(!getGoogleBackupConfig()){ showToast("先に「設定・バックアップ」でGoogle連携を設定してください", true); return; }
confirmDialog("この座席表を保存します。後から履歴で確認できます。よろしいですか？", ()=>{
showToast("この授業を保存しています…");
const prev = loadGoogleBackupStatus();
persistGoogleBackupStatus(Object.assign({}, prev, { phase: "saving" }));
applyGoogleBackupUi();
postGoogleBackupApi("finalizeLesson", { json: getLiveState(), targetDate: currentDate }).then(data=>{
persistGoogleBackupStatus({
phase: "ok",
lastOkAt: data.updatedAt || new Date().toISOString(),
lastError: "",
lastFileName: data.fileName || ""
});
applyGoogleBackupUi();
showToast("この授業を保存しました");
}).catch(err=>{
persistGoogleBackupStatus({
phase: "error",
lastOkAt: prev.lastOkAt || "",
lastError: (err && err.message) || "failed",
lastFileName: prev.lastFileName || ""
});
applyGoogleBackupUi();
showToast(googleErrorMessage(err && err.message), true);
});
});
}
function emptyBlock(seatCount=8){
return {
id: uid(), time: "時間を入力",
seats: Array.from({length:seatCount}, (_,i)=>emptySeat(i+1)),
groupRows: []
};
}
function emptySeat(n){
return {
seatNumber: String(n), teacher: "",
left: {student:"",subject:"",grade:"",status:"normal"},
right: {student:"",subject:"",grade:"",status:"normal"}
};
}

/* ---------------- subject suggestions ---------------- */
function allSubjectSuggestions(){
const used = new Set(DEFAULT_SUBJECTS);
state.customSubjects.forEach(s=> s && used.add(s));
state.students.forEach(s=> splitSubjectList(s.subject).forEach(sub=> used.add(sub)));
return Array.from(used);
}
function registerCustomSubject(val){
if(!val) return;
if(DEFAULT_SUBJECTS.includes(val)) return;
if(!state.customSubjects.includes(val)){
state.customSubjects.push(val);
}
}
function subjectDatalist(){
return `<datalist id="subjectList">${allSubjectSuggestions().map(s=>`<option value="${escapeHtml(s)}">`).join("")}</datalist>`;
}

/* ---------------- helpers ---------------- */
function escapeHtml(str){
return String(str==null?"":str).replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
}
function showToast(msg, isError){
const t = document.getElementById("toast");
t.textContent = msg;
t.hidden = false;
t.classList.toggle("error", !!isError);
clearTimeout(t._timer);
t._timer = setTimeout(()=>{ t.hidden = true; }, 3200);
}
function jaCollator(){
return new Intl.Collator("ja");
}
const NEW_STUDENT_VALUE = "__new_student__";

function rosterNameKey(name){
return String(name == null ? "" : name).replace(/[\s\u3000]+/g, "");
}
function findStudentIndexByName(name){
const key = rosterNameKey(name);
if(!key) return -1;
return state.students.findIndex(s=> rosterNameKey(s.name) === key);
}
function findTeacherIndexByName(name){
const key = rosterNameKey(name);
if(!key) return -1;
return state.teachers.findIndex(t=> rosterNameKey(t.name) === key);
}
function splitSubjectList(raw){
return String(raw == null ? "" : raw)
.split(/[・･,、/／]+/)
.map(s=> normalizeName(s))
.filter(Boolean);
}
function mergeSubjectList(existing, incoming){
const out = [];
const seen = new Set();
splitSubjectList(existing).concat(splitSubjectList(incoming)).forEach(part=>{
const key = rosterNameKey(part).toLowerCase();
if(!key || seen.has(key)) return;
seen.add(key);
out.push(part);
});
return out.join("・");
}
function ensureStudentOnRoster(name, extra){
name = normalizeName(name);
if(!name || name === NEW_STUDENT_VALUE) return { added: false, name: "" };
const i = findStudentIndexByName(name);
if(i >= 0){
const s = state.students[i];
if(extra){
if(extra.grade && !String(s.grade || "").trim()) s.grade = extra.grade;
if(extra.subject) s.subject = mergeSubjectList(s.subject, extra.subject);
}
return { added: false, name: s.name };
}
state.students.push({
id: uid(),
name,
birthdate: "",
grade: extra && extra.grade ? extra.grade : "",
subject: extra && extra.subject ? mergeSubjectList("", extra.subject) : ""
});
return { added: true, name };
}
function ensureTeacherOnRoster(name){
name = normalizeName(name);
if(!name) return { added: false, name: "" };
const i = findTeacherIndexByName(name);
if(i >= 0) return { added: false, name: state.teachers[i].name };
state.teachers.push({ id: uid(), name, subjects: "", note: "" });
return { added: true, name };
}
function ensureRosterFromDay(day){
let students = 0, teachers = 0;
(day && day.blocks || []).forEach(b=>{
(b.seats || []).forEach(seat=>{
if(ensureTeacherOnRoster(seat.teacher).added) teachers++;
["left","right"].forEach(side=>{
const cell = seat[side];
if(cell && ensureStudentOnRoster(cell.student, { grade: cell.grade, subject: cell.subject }).added) students++;
});
});
(b.groupRows || []).forEach(g=>{
if(ensureTeacherOnRoster(g.teacher).added) teachers++;
(g.students || []).forEach(n=>{
if(ensureStudentOnRoster(n, { subject: g.subject }).added) students++;
});
});
});
return { students, teachers };
}
function openNewStudentModal(onOk, onCancel){
openModal(`
<h3>新しい生徒を追加</h3>
<p class="sub">氏名を入力すると生徒名簿にも追加されます。</p>
<input type="text" id="newStudentName" placeholder="氏名" autocomplete="off" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:8px;">
<div class="modal-actions">
<button class="btn" id="modalCancel">キャンセル</button>
<button class="btn primary" id="modalConfirm">追加する</button>
</div>
`, (modal)=>{
const input = modal.querySelector("#newStudentName");
input.focus();
const cancel = ()=>{ closeModal(); if(onCancel) onCancel(); };
modal.querySelector("#modalCancel").addEventListener("click", cancel);
const confirm = ()=>{
const name = normalizeName(input.value);
if(!name){ showToast("氏名を入力してください", true); return; }
closeModal();
onOk(name);
};
modal.querySelector("#modalConfirm").addEventListener("click", confirm);
input.addEventListener("keydown", (e)=>{
if(e.key === "Enter"){ e.preventDefault(); confirm(); }
});
const backdrop = document.querySelector("#modalRoot .modal-backdrop");
if(backdrop){
backdrop.addEventListener("click", (e)=>{ if(e.target === backdrop && onCancel) onCancel(); });
}
});
}
function rosterStudentNames(selected){
const src = getDisplayState();
const names = src.students.map(s=> (s && s.name) ? String(s.name).trim() : "").filter(Boolean);
const unique = [];
const seen = new Set();
names.forEach(n=>{
if(seen.has(n)) return;
seen.add(n);
unique.push(n);
});
if(selected && !seen.has(selected)) unique.push(selected);
unique.sort((a,b)=> jaCollator().compare(a, b));
return unique;
}
function weekdayOf(dateStr){
const [y,m,d] = dateStr.split("-").map(Number);
return new Date(y, m-1, d).getDay();
}

/* Find every place a teacher name is currently referenced (for delete warnings) */
function teacherUsageCount(name){
let count = 0;
const scanDay = (day)=>{
day.blocks.forEach(b=>{
b.seats.forEach(s=>{ if(s.teacher === name) count++; });
b.groupRows.forEach(g=>{ if(g.teacher === name) count++; });
});
};
Object.values(state.days).forEach(scanDay);
Object.values(state.weekdayPresets).forEach(scanDay);
return count;
}
function studentUsageCount(name){
let count = 0;
const scanDay = (day)=>{
day.blocks.forEach(b=>{
b.seats.forEach(s=>{
if(s.left.student === name) count++;
if(s.right.student === name) count++;
});
b.groupRows.forEach(g=>{ count += g.students.filter(n=>n===name).length; });
});
};
Object.values(state.days).forEach(scanDay);
Object.values(state.weekdayPresets).forEach(scanDay);
return count;
}

/* =========================================================
Modal helper
========================================================= */
function openModal(html, onMount){
const root = document.getElementById("modalRoot");
root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
const backdrop = root.querySelector(".modal-backdrop");
backdrop.addEventListener("click", (e)=>{ if(e.target === backdrop) closeModal(); });
if(onMount) onMount(root.querySelector(".modal"));
}
function closeModal(){
document.getElementById("modalRoot").innerHTML = "";
}

/* =========================================================
TAB SWITCHING
========================================================= */
function initTabs(){
document.getElementById("tabs").addEventListener("click",(e)=>{
const btn = e.target.closest(".tab-btn");
if(!btn) return;
currentTab = btn.dataset.tab;
renderTabs();
renderCurrentView();
});
}
function renderTabs(){
document.querySelectorAll(".tab-btn").forEach(b=>{
b.classList.toggle("active", b.dataset.tab === currentTab);
});
document.getElementById("studentCount").textContent = state.students.length;
document.getElementById("teacherCount").textContent = state.teachers.length;
["seat","students","teachers","print","settings"].forEach(name=>{
document.getElementById("view-"+name).hidden = (name !== currentTab);
});
}
function renderCurrentView(){
if(currentTab === "seat") renderSeatView();
else if(currentTab === "students") renderStudentsView();
else if(currentTab === "teachers") renderTeachersView();
else if(currentTab === "print") renderPrintPreviewView();
else if(currentTab === "settings") renderSettingsView();
}

/* =========================================================
SEAT VIEW
========================================================= */
function renderSeatView(){
const el = document.getElementById("view-seat");
const day = getOrCreateDay(currentDate);
const wd = weekdayOf(currentDate);
const dateObj = new Date(currentDate+"T00:00:00");
const dateLabel = `${dateObj.getFullYear()}年${dateObj.getMonth()+1}月${dateObj.getDate()}日（${WEEKDAY_LABELS[wd]}）`;
const viewingPast = isHistoryView();

el.innerHTML = `
<div class="panel page-head">
<div class="seat-date-bar">
<h2>${dateLabel}${viewingPast ? ` <span class="history-view-badge">履歴表示</span>` : ""}</h2>
<label class="date-field">日付
<input type="date" id="datePicker" value="${currentDate}" ${viewingPast ? "disabled" : ""}>
</label>
</div>
<div class="seat-history-actions toolbar-group">
<span class="toolbar-label">授業履歴</span>
<div class="btn-row">
<button class="btn" id="btnLessonHistory">授業履歴</button>
<button class="btn" id="btnCopyLastWeek" ${viewingPast ? "disabled" : ""}>先週をコピー</button>
<button class="btn primary" id="btnFinalizeLesson" ${viewingPast ? "disabled" : ""}>この授業を保存</button>
</div>
</div>
${viewingPast ? "" : imagesHtml()}
<div class="seat-toolbar">
<div class="toolbar-group">
<span class="toolbar-label">座席操作</span>
<div class="btn-row js-seat-actions">
<button class="btn primary" id="btnAddBlock" ${viewingPast ? "disabled" : ""}>＋ 授業枠を追加</button>
<button class="btn danger" id="btnDeleteGroupRows" ${viewingPast ? "disabled" : ""}>この日の集団行を削除</button>
<button class="btn danger" id="btnDeleteAll" ${viewingPast ? "disabled" : ""}>この日をすべて削除</button>
</div>
</div>
<div class="toolbar-group">
<span class="toolbar-label">共有操作</span>
<div class="btn-row js-share-actions">
<button class="btn" id="btnImportEweb" ${viewingPast ? "disabled" : ""}>eWebから読み込む</button>
<button class="btn" id="btnImportImage" ${viewingPast ? "disabled" : ""}>画像から取り込み</button>
<button class="btn" id="btnPrint">A3横で印刷</button>
<button class="btn" id="btnPrintMulti" ${viewingPast ? "disabled" : ""}>複数日を印刷</button>
</div>
</div>
</div>
</div>

${viewingPast ? "" : `<div class="preset-panel">
<div>
<div class="preset-title">基本曜日プリセット
<small>曜日ごとのいつもの座席表を保存・呼び出し</small>
</div>
</div>
<div class="weekday-grid" id="weekdayGrid"></div>
<div class="preset-actions">
<button class="btn" id="btnLoadPreset">この曜日を呼び出す</button>
<button class="btn primary" id="btnSavePreset">現在の表を${WEEKDAY_LABELS[wd]}曜日の基本に保存</button>
</div>
</div>`}

<div class="legend">
<span><span class="swatch course"></span>講習</span>
<span><span class="swatch transfer"></span>振替</span>
<span><span class="swatch absent"></span>欠席</span>
<span><span class="swatch solo"></span>1対1</span>
<span><span class="swatch trial"></span>体験授業</span>
<span>生徒名の下のボタンでワンタップ切り替え</span>
</div>

<div class="blocks" id="blocksWrap"></div>
${subjectDatalist()}
`;

// weekday chips
const grid = document.getElementById("weekdayGrid");
if(grid){
const presetSource = getDisplayState();
grid.innerHTML = WEEKDAY_LABELS.map((label,i)=>{
const hasPreset = !!(presetSource.weekdayPresets[i] && presetSource.weekdayPresets[i].blocks && presetSource.weekdayPresets[i].blocks.length);
return `<div class="weekday-chip ${i===wd?"selected":""} ${hasPreset?"has-preset":""}" data-wd="${i}">
<span class="wd-label">${hasPreset?"登録済":"未登録"}</span>${label}
</div>`;
}).join("");
}

document.getElementById("btnLessonHistory").addEventListener("click", openLessonHistoryModal);
document.getElementById("btnFinalizeLesson").addEventListener("click", finalizeCurrentLesson);

const datePicker = document.getElementById("datePicker");
if(datePicker && !viewingPast){
datePicker.addEventListener("change", e=>{
currentDate = e.target.value || todayStr();
renderSeatView();
});
}
updateHistoryBanner();
if(!viewingPast){
document.getElementById("btnAddBlock").addEventListener("click", ()=>{
day.blocks.push(emptyBlock());
saveState(); renderSeatView();
});
document.getElementById("btnDeleteAll").addEventListener("click", ()=>{
const st = dayStats(day);
confirmThenBackup(`${dateLabel} の座席表をすべて削除します（授業枠 ${st.blocks}・席 ${st.seats}・集団行 ${st.groups}）。この日の内容は空になります。よろしいですか？`, ()=>{
day.blocks = [];
saveState(); renderSeatView();
});
});
document.getElementById("btnDeleteGroupRows").addEventListener("click", ()=>{
const st = dayStats(day);
confirmThenBackup(`${dateLabel} の集団行だけをすべて削除します（集団行 ${st.groups} 件）。座席の1対1／1対2はそのまま残ります。よろしいですか？`, ()=>{
day.blocks.forEach(b=> b.groupRows = []);
saveState(); renderSeatView();
});
});
document.getElementById("btnPrintMulti").addEventListener("click", openMultiDayPrintModal);
document.getElementById("btnImportImage").addEventListener("click", openImageImportModal);
document.getElementById("btnImportEweb").addEventListener("click", openEwebImportModal);
document.getElementById("btnCopyLastWeek").addEventListener("click", openCopyLastWeekModal);
const btnLoadPreset = document.getElementById("btnLoadPreset");
if(btnLoadPreset){
btnLoadPreset.addEventListener("click", ()=>{
const preset = state.weekdayPresets[wd];
if(!preset || !preset.blocks.length){ showToast(`${WEEKDAY_LABELS[wd]}曜日の基本形はまだ登録されていません`, true); return; }
confirmDialog(`${WEEKDAY_LABELS[wd]}曜日の基本形をこの日に読み込みます。現在のこの日の内容は上書きされます。よろしいですか？`, ()=>{
state.days[currentDate] = JSON.parse(JSON.stringify(preset));
migrate(state);
saveState(); renderSeatView();
});
});
}
const btnSavePreset = document.getElementById("btnSavePreset");
if(btnSavePreset){
btnSavePreset.addEventListener("click", ()=>{
confirmDialog(`現在のこの日の座席表を「${WEEKDAY_LABELS[wd]}曜日の基本形」として保存します。よろしいですか？`, ()=>{
state.weekdayPresets[wd] = JSON.parse(JSON.stringify(day));
saveState(); renderSeatView();
});
});
}
if(grid){
grid.addEventListener("click", (e)=>{
const chip = e.target.closest(".weekday-chip");
if(!chip) return;
const targetWd = Number(chip.dataset.wd);
showToast(`${WEEKDAY_LABELS[targetWd]}曜日の基本形は「この曜日を呼び出す」ボタンで、その曜日の日付を選んだ状態で読み込めます。`);
});
}
}
document.getElementById("btnPrint").addEventListener("click", ()=> runMultiDayPrint([currentDate]));

renderBlocks(day, dateLabel);
}

function renderBlocks(day, dateLabel){
const wrap = document.getElementById("blocksWrap");
if(!day.blocks.length){
wrap.innerHTML = `<div class="empty-note">この日にはまだ授業枠がありません。「＋ 授業枠を追加」から作成してください。</div>`;
return;
}
wrap.innerHTML = day.blocks.map((block, bi)=> blockHtml(block, bi)).join("");

day.blocks.forEach((block, bi)=> bindBlockEvents(day, block, bi));
}

function uniqueBlockTeachers(block){
const names = [];
const seen = {};
function add(raw){
const display = String(raw || "").replace(/[\s\u3000]+/g, " ").trim();
if(!display) return;
if(seen[display]) return;
seen[display] = true;
names.push(display);
}
(block.seats || []).forEach(seat=> add(seat && seat.teacher));
(block.groupRows || []).forEach(row=> add(row && row.teacher));
return names;
}

function blockTeachersLabel(block){
const names = uniqueBlockTeachers(block);
return names.length ? names.join(" / ") : "講師未設定";
}

function refreshBlockTeachersHeading(blockEl, block){
const el = blockEl && blockEl.querySelector(".block-teachers");
if(!el) return;
el.textContent = blockTeachersLabel(block);
}

function normSoloName(s){ return String(s || "").replace(/[\s\u3000]+/g, ""); }
function stripSoloBrackets(subj){ return String(subj || "").replace(/[<\uFF1C][^>\uFF1E]*[>\uFF1E]/g, "").trim(); }
function soloComboKey(name, subj){ return normSoloName(name) + "\u2016" + normSoloName(stripSoloBrackets(subj)); }
function loadSoloMapForDate(dateStr){
try{
const all = JSON.parse(STORAGE.getItem("seat-table-solo") || "{}") || {};
return all[dateStr] || {};
}catch(e){ return {}; }
}
/* 1対1の斜線。各セル内のSVG実要素として置く（背景グラフィックOFFでも印刷される）。
   パターンIDはセルごとに一意にして、hiddenな別画面の同名IDに引っ張られないようにする。 */
function soloSlashMarkHtml(){
const id = "solo-slash-p-" + uid();
const clip = id + "-clip";
return `<svg class="solo-slash-mark" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" overflow="hidden"><defs><clipPath id="${clip}" clipPathUnits="objectBoundingBox"><rect width="1" height="1"/></clipPath><pattern id="${id}" patternUnits="userSpaceOnUse" width="18" height="18"><path d="M-2 20 L20 -2" stroke="#000" stroke-width="0.9" fill="none"/></pattern></defs><rect width="100%" height="100%" fill="url(#${id})" clip-path="url(#${clip})"/></svg>`;
}

function blockHtml(block, bi, dateStr){
const seatRows = block.seats.map((seat,si)=> seatRowHtml(block, seat, si, dateStr)).join("");
const groupRows = block.groupRows.map((g,gi)=> groupRowHtml(block, g, gi)).join("");

return `
<div class="lesson-block" data-block="${block.id}" data-time="${escapeHtml(/[0-9]/.test(block.time||'') ? block.time : '')}">
<div class="block-head">
<div class="block-head-left">
<span class="block-index">枠${bi+1}</span>
<div class="block-teachers">${escapeHtml(blockTeachersLabel(block))}</div>
<div class="time-input">
<span>時間帯</span>
<input type="time" class="js-time-start" value="${(block.time.split("〜")[0]||"").trim()}">
<span>〜</span>
<input type="time" class="js-time-end" value="${(block.time.split("〜")[1]||"").trim()}">
</div>
<div class="time-choice">
<select class="js-time-preset">
<option value="">よく使う時間</option>
${COMMON_TIME_PRESETS.map(t=>`<option value="${t}" ${t===block.time?"selected":""}>${t}</option>`).join("")}
</select>
</div>
</div>
<div class="block-actions">
<button class="btn js-add-seat">＋ 席を追加</button>
<button class="btn js-remove-seat">− 席を減らす</button>
<button class="btn js-add-group">＋ 集団行</button>
<button class="btn js-copy-down">下にコピー</button>
<button class="btn danger js-del-block">この時間を削除</button>
</div>
</div>
<div class="sheet-wrap">
<div class="sheet">
<div class="sheet-header">
<div class="th">席</div>
<div class="th">担当講師</div>
<div class="th side-left">左側</div>
<div class="th side-right">右側</div>
</div>
<div class="sheet-header sub">
<div class="th sub-head blank2"></div>
<div class="th sub-head">科目</div>
<div class="th sub-head">学年</div>
<div class="th sub-head">生徒名</div>
<div class="th sub-head">科目</div>
<div class="th sub-head">学年</div>
<div class="th sub-head">生徒名</div>
</div>
<div class="sheet-body">
${seatRows}
${groupRows}
</div>
</div>
</div>
</div>`;
}

function seatRowHtml(block, seat, si, dateStr){
const roster = getDisplayState();
const teacherOptions = `<option value="">—</option>` + roster.teachers.map(t=>`<option value="${escapeHtml(t.name)}" ${seat.teacher===t.name?"selected":""}>${escapeHtml(t.name)}</option>`).join("");
const studOpts = (selected)=> `<option value="">生徒を選択</option><option value="${NEW_STUDENT_VALUE}">＋ 新しい生徒を追加</option>` + rosterStudentNames(selected).map(name=>`<option value="${escapeHtml(name)}" ${selected===name?"selected":""}>${escapeHtml(name)}</option>`).join("");
const soloMap = loadSoloMapForDate(dateStr || currentDate);
const leftName = normSoloName(seat.left && seat.left.student);
const rightName = normSoloName(seat.right && seat.right.student);
const leftSolo = !!(leftName && soloMap[soloComboKey(leftName, seat.left && seat.left.subject)]);
const rightSolo = !!(rightName && soloMap[soloComboKey(rightName, seat.right && seat.right.subject)]);
const blockRight = leftSolo && !rightName;
const blockLeft = rightSolo && !leftName;

const sideHtml = (side, key, blocked)=>`
<div class="cell${blocked?" solo-blocked":""}">
<input list="subjectList" class="subject-select js-subject" data-side="${key}" value="${escapeHtml(side.subject)}" placeholder="—">
${blocked?soloSlashMarkHtml():""}
</div>
<div class="cell${blocked?" solo-blocked":""}">
<input type="text" class="grade-input js-grade" data-side="${key}" value="${escapeHtml(side.grade)}" placeholder="学年">
${blocked?soloSlashMarkHtml():""}
</div>
<div class="cell student-cell status-${side.status} js-student-cell${blocked?" solo-blocked":""}" data-side="${key}">
<select class="student-select js-student" data-side="${key}">${studOpts(side.student)}</select>
<div class="status-buttons">
<button type="button" class="js-status ${side.status==='course'?'active course':''}" data-side="${key}" data-status="course">講習</button>
<button type="button" class="js-status ${side.status==='transfer'?'active transfer':''}" data-side="${key}" data-status="transfer">振替</button>
<button type="button" class="js-status ${side.status==='absent'?'active absent':''}" data-side="${key}" data-status="absent">欠席</button>
</div>
${blocked?soloSlashMarkHtml():""}
</div>`;

return `
<div class="seat-row-wrap ${si%2===1?'alt-row':''}" data-seat-index="${si}">
<div class="cell seat-num-cell">
<input type="text" class="js-seat-num" value="${escapeHtml(seat.seatNumber)}" aria-label="${si+1}行目の席番号">
<div class="seat-move">
<button type="button" class="js-move-up" title="上へ移動" ${si===0?"disabled":""}>▲</button>
<button type="button" class="js-move-down" title="下へ移動" ${si===block.seats.length-1?"disabled":""}>▼</button>
</div>
</div>
<div class="cell teacher-col">
<select class="js-teacher">${teacherOptions}</select>
</div>
${sideHtml(seat.left,"left", blockLeft)}
${sideHtml(seat.right,"right", blockRight)}
</div>
`;
}

function groupRowHtml(block, g, gi){
const roster = getDisplayState();
const teacherOptions = `<option value="">—</option>` + roster.teachers.map(t=>`<option value="${escapeHtml(t.name)}" ${g.teacher===t.name?"selected":""}>${escapeHtml(t.name)}</option>`).join("");
const remainingStudents = rosterStudentNames().filter(name=> !g.students.includes(name));
const chips = g.students.map(name=>`<span class="chip">${escapeHtml(name)}<button type="button" class="js-remove-gstudent" data-name="${escapeHtml(name)}">×</button></span>`).join("");
return `
<div class="group-row-wrap" data-group-index="${gi}">
<div class="cell seat-num-cell group-row">
<input type="text" class="js-g-seat-num" value="${escapeHtml(g.seatNumber)}" placeholder="使用席">
</div>
<div class="cell teacher-col group-row">
<select class="js-g-teacher">${teacherOptions}</select>
</div>
<div class="cell group-row">
<input list="subjectList" class="subject-select js-g-subject" value="${escapeHtml(g.subject)}" placeholder="科目">
</div>
<div class="cell group-row group-count-cell">
<span class="group-count-badge">${g.students.length}名</span>
</div>
<div class="cell group-row group-name-cell">
<input type="text" class="js-g-name" value="${escapeHtml(g.name)}" placeholder="授業名／グループ名">
</div>
<div class="cell group-row group-students-cell" style="grid-column: span 3;">
<div class="chip-list">${chips}</div>
<div class="group-students-footer">
<select class="js-g-add-student add-student-chip">
<option value="">＋ 生徒を追加</option>
<option value="${NEW_STUDENT_VALUE}">＋ 新しい生徒を追加</option>
${remainingStudents.map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}
</select>
<button type="button" class="btn danger js-del-group">削除</button>
</div>
</div>
</div>
`;
}
function bindBlockEvents(day, block, bi){
const root = document.querySelector(`.lesson-block[data-block="${block.id}"]`);
if(!root) return;

const applyTime = ()=>{
const s = root.querySelector(".js-time-start").value;
const e = root.querySelector(".js-time-end").value;
if(s && e) block.time = `${s}〜${e}`;
saveState();
};
root.querySelector(".js-time-start").addEventListener("change", applyTime);
root.querySelector(".js-time-end").addEventListener("change", applyTime);
root.querySelector(".js-time-preset").addEventListener("change", (e)=>{
if(e.target.value){ block.time = e.target.value; saveState(); renderSeatView(); }
});

root.querySelector(".js-add-seat").addEventListener("click", ()=>{
block.seats.push(emptySeat(block.seats.length+1));
saveState(); renderSeatView();
});
root.querySelector(".js-remove-seat").addEventListener("click", ()=>{
if(block.seats.length<=1){ showToast("これ以上は減らせません", true); return; }
block.seats.pop();
saveState(); renderSeatView();
});
root.querySelector(".js-add-group").addEventListener("click", ()=>{
block.groupRows.push({id:uid(), seatNumber:"", name:"", teacher:"", subject:"", students:[]});
saveState(); renderSeatView();
});
root.querySelector(".js-copy-down").addEventListener("click", ()=>{
const clone = JSON.parse(JSON.stringify(block));
clone.id = uid();
clone.groupRows.forEach(g=> g.id = uid());
day.blocks.splice(bi+1, 0, clone);
saveState(); renderSeatView();
});
root.querySelector(".js-del-block").addEventListener("click", ()=>{
const dateLabel2 = `${currentDate}（${block.time || "時間未設定"}）`;
confirmThenBackup(`${dateLabel2} の授業枠を削除します（席 ${block.seats.length}・集団行 ${block.groupRows.length}）。この時間帯の内容はなくなります。よろしいですか？`, ()=>{
day.blocks.splice(bi,1);
saveState(); renderSeatView();
});
});

// Use event delegation within the sheet for seat-level controls
const sheet = root.querySelector(".sheet");
sheet.addEventListener("change", (e)=>{
handleSeatFieldChange(e, block);
});
sheet.addEventListener("click", (e)=>{
handleSeatClick(e, block, day);
});
}

function seatIndexFromEl(el, block){
// seat rows are rendered in DOM order matching block.seats then groupRows;
// use data attributes set on the seat-num input to locate index via closest structural offset
return null;
}

function handleSeatFieldChange(e, block){
const t = e.target;
if(t.classList.contains("js-seat-num")){
const idx = seatRowIndex(t);
if(idx>-1){
block.seats[idx].seatNumber = t.value;
const synced = syncSeatNumberAcrossBlocks(block, block.seats[idx].teacher, t.value);
saveState();
if(synced) renderSeatView();
}
return;
}
if(t.classList.contains("js-teacher")){
const idx = seatRowIndex(t);
if(idx>-1){
block.seats[idx].teacher = t.value;
saveState();
refreshBlockTeachersHeading(t.closest(".lesson-block"), block);
}
return;
}
if(t.classList.contains("js-subject")){
const idx = seatRowIndex(t);
const side = t.dataset.side;
if(idx>-1){
const cell = block.seats[idx][side];
cell.subject = t.value;
registerCustomSubject(t.value);
if(cell.student) ensureStudentOnRoster(cell.student, { subject: t.value });
saveState();
}
return;
}
if(t.classList.contains("js-grade")){
const idx = seatRowIndex(t);
const side = t.dataset.side;
if(idx>-1){ block.seats[idx][side].grade = t.value; saveState(); }
return;
}
if(t.classList.contains("js-student")){
const idx = seatRowIndex(t);
const side = t.dataset.side;
if(idx>-1){
const cell = block.seats[idx][side];
if(t.value === NEW_STUDENT_VALUE){
const prev = cell.student || "";
openNewStudentModal((name)=>{
const ensured = ensureStudentOnRoster(name, { grade: cell.grade, subject: cell.subject });
cell.student = ensured.name;
saveState();
renderTabs();
renderSeatView();
}, ()=>{ t.value = prev; });
return;
}
cell.student = t.value;
if(t.value) ensureStudentOnRoster(t.value, { grade: cell.grade, subject: cell.subject });
saveState();
}
return;
}
if(t.classList.contains("js-g-teacher")){
const idx = groupRowIndex(t);
if(idx>-1){
block.groupRows[idx].teacher = t.value;
saveState();
refreshBlockTeachersHeading(t.closest(".lesson-block"), block);
}
return;
}
if(t.classList.contains("js-g-name")){
const idx = groupRowIndex(t);
if(idx>-1){ block.groupRows[idx].name = t.value; saveState(); }
return;
}
if(t.classList.contains("js-g-subject")){
const idx = groupRowIndex(t);
if(idx>-1){
const g = block.groupRows[idx];
g.subject = t.value;
registerCustomSubject(t.value);
(g.students || []).forEach(n=> ensureStudentOnRoster(n, { subject: t.value }));
saveState();
}
return;
}
if(t.classList.contains("js-g-seat-num")){
const idx = groupRowIndex(t);
if(idx>-1){ block.groupRows[idx].seatNumber = t.value; saveState(); }
return;
}
if(t.classList.contains("js-g-add-student")){
const idx = groupRowIndex(t);
if(idx>-1 && t.value){
const g = block.groupRows[idx];
if(t.value === NEW_STUDENT_VALUE){
openNewStudentModal((name)=>{
const ensured = ensureStudentOnRoster(name, { subject: g.subject });
if(ensured.name && !g.students.includes(ensured.name)) g.students.push(ensured.name);
saveState();
renderTabs();
renderSeatView();
}, ()=>{ t.value = ""; });
return;
}
ensureStudentOnRoster(t.value, { subject: g.subject });
g.students.push(t.value);
saveState(); renderSeatView();
}
return;
}
}

function handleSeatClick(e, block, day){
const up = e.target.closest(".js-move-up");
const down = e.target.closest(".js-move-down");
const status = e.target.closest(".js-status");
const delGroup = e.target.closest(".js-del-group");
const removeG = e.target.closest(".js-remove-gstudent");

if(up){
const idx = seatRowIndex(up);
if(idx>0){ [block.seats[idx-1], block.seats[idx]] = [block.seats[idx], block.seats[idx-1]]; saveState(); renderSeatView(); }
return;
}
if(down){
const idx = seatRowIndex(down);
if(idx>-1 && idx<block.seats.length-1){ [block.seats[idx+1], block.seats[idx]] = [block.seats[idx], block.seats[idx+1]]; saveState(); renderSeatView(); }
return;
}
if(status){
const idx = seatRowIndex(status);
const side = status.dataset.side;
const val = status.dataset.status;
if(idx>-1){
const cur = block.seats[idx][side].status;
block.seats[idx][side].status = (cur===val) ? "normal" : val;
saveState(); renderSeatView();
}
return;
}
if(delGroup){
const idx = groupRowIndex(delGroup);
if(idx>-1){
const g = block.groupRows[idx];
const gname = (g && g.name) ? g.name : "（無名）";
confirmThenBackup(`${currentDate} ${block.time || ""} の集団行「${gname}」を削除します（生徒 ${((g && g.students) || []).length} 名）。よろしいですか？`, ()=>{
block.groupRows.splice(idx,1);
saveState(); renderSeatView();
});
}
return;
}
if(removeG){
const idx = groupRowIndex(removeG);
const name = removeG.dataset.name;
if(idx>-1){
block.groupRows[idx].students = block.groupRows[idx].students.filter(n=>n!==name);
saveState(); renderSeatView();
}
return;
}
}

/* Row index lookup: each seat row / group row is wrapped in a display:contents
container carrying data-seat-index / data-group-index, so we just read it back. */
function seatRowIndex(el){
const wrap = el.closest("[data-seat-index]");
return wrap ? Number(wrap.dataset.seatIndex) : -1;
}

function normTeacherName(s){
return String(s || "").replace(/[\s\u3000]+/g, "");
}

function isSeatNumberSyncEnabled(){
try{
const v = STORAGE.getItem("seat-table-sync-enabled");
return v === null ? true : v === "1";
}catch(e){
return true;
}
}

/* 同じ日の他の授業枠にいる同じ講師へ席番号を反映する。
   いま編集中の枠は本体側で既に更新済みなので対象外（二重処理しない）。 */
function syncSeatNumberAcrossBlocks(sourceBlock, teacherName, newNumber){
if(!isSeatNumberSyncEnabled()) return false;
const teacher = normTeacherName(teacherName);
if(!teacher) return false;
const day = state && state.days ? state.days[currentDate] : null;
if(!day || !Array.isArray(day.blocks)) return false;
let changed = false;
day.blocks.forEach(block=>{
if(!block || block === sourceBlock || (sourceBlock && block.id && block.id === sourceBlock.id)) return;
(block.seats || []).forEach(seat=>{
if(normTeacherName(seat.teacher) !== teacher) return;
if(String(seat.seatNumber ?? "") === String(newNumber ?? "")) return;
seat.seatNumber = newNumber;
changed = true;
});
});
return changed;
}
function groupRowIndex(el){
const wrap = el.closest("[data-group-index]");
return wrap ? Number(wrap.dataset.groupIndex) : -1;
}

/* ---------------- copy last week ---------------- */
function openCopyLastWeekModal(){
const lastWeekDate = shiftDate(currentDate, -7);
const source = state.days[lastWeekDate];
if(!source || !source.blocks.length){
showToast(`先週（${lastWeekDate}）の座席表が見つかりません`, true);
return;
}
openModal(`
<h3>先週の座席表をコピー</h3>
<p>コピー元：${lastWeekDate} → コピー先：${currentDate}</p>
<div class="option-list">
<label class="opt"><input type="radio" name="copyScope" value="all" checked> すべてコピー</label>
<label class="opt"><input type="radio" name="copyScope" value="individual"> 個別授業だけコピー</label>
<label class="opt"><input type="radio" name="copyScope" value="group"> 集団授業だけコピー</label>
</div>
<label class="opt"><input type="checkbox" id="copyReplace"> コピー先の既存内容を削除してから貼り付ける（未チェックの場合は末尾に追加し、重複防止のため既にコピー済みの枠は追加しません）</label>
<div class="modal-actions">
<button class="btn" id="modalCancel">キャンセル</button>
<button class="btn primary" id="modalConfirm">コピーする</button>
</div>
`, (modal)=>{
modal.querySelector("#modalCancel").addEventListener("click", closeModal);
modal.querySelector("#modalConfirm").addEventListener("click", ()=>{
const scope = modal.querySelector('input[name="copyScope"]:checked').value;
const replace = modal.querySelector("#copyReplace").checked;
doCopyLastWeek(source, scope, replace);
closeModal();
renderSeatView();
});
});
}
function shiftDate(dateStr, days){
const d = new Date(dateStr+"T00:00:00");
d.setDate(d.getDate()+days);
return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
}
function doCopyLastWeek(source, scope, replace){
const target = getOrCreateDay(currentDate);
if(replace) target.blocks = [];
const existingSourceIds = new Set(target.blocks.map(b=>b._copiedFrom).filter(Boolean));
source.blocks.forEach(srcBlock=>{
if(!replace && existingSourceIds.has(srcBlock.id)) return; // already copied, avoid duplicate
const clone = JSON.parse(JSON.stringify(srcBlock));
clone._copiedFrom = srcBlock.id;
clone.id = uid();
if(scope==="individual") clone.groupRows = [];
if(scope==="group") clone.seats = [];
clone.groupRows.forEach(g=> g.id = uid());
target.blocks.push(clone);
});
saveState();
showToast("先週の座席表をコピーしました");
}

/* ---------------- image import (assist, not automatic OCR) ---------------- */
function openImageImportModal(){
openModal(`
<h3>画像から取り込み</h3>
<p>授業予定表の画像を確認しながら、右側の座席表へ手入力するための補助ウィンドウです。
このアプリは外部サーバーを持たないため、画像から科目・担当講師・生徒を自動認識する処理は含まれていません
（旧サイトの自動認識機能は、精度の問題や「読み取れない担当講師を推測しない」というご要望と両立させるため、
今回はあえて手動確認方式にしています）。</p>
<input type="file" id="imgFile" accept="image/*">
<div id="imgPreviewWrap" style="margin-top:10px;"></div>
<div class="modal-actions">
<button class="btn" id="modalCancel">閉じる</button>
</div>
`, (modal)=>{
modal.querySelector("#modalCancel").addEventListener("click", closeModal);
modal.querySelector("#imgFile").addEventListener("change", (e)=>{
const file = e.target.files[0];
if(!file) return;
const url = URL.createObjectURL(file);
modal.querySelector("#imgPreviewWrap").innerHTML = `<img src="${url}" style="max-width:100%;border:1px solid #ddd;border-radius:6px;">`;
});
});
}

/* ---------------- eWeb import ---------------- */
/*
eWeb（授業予定管理システム）の座席表ページで、ブックマークレット「eWeb取込」を実行すると、
その日の予定がクリップボードにJSON形式でコピーされます。それをここに貼り付けて取り込みます。

期待するJSON形式：
{
"date": "2026-07-27",
"komas": [{"id":49,"name":"A","start":"17:10","end":"18:40"}, ...],
"items": [{"koma_id":49,"teacher_name":"堀部 晃平","student_name":"平木 愛琉","grade":"中3","subject":"講(数)","pos":1}, ...],
"groups": [{"koma_id":47,"start":"14:50","end":"15:50","name":"中3社会-2026夏期集団","teacher_name":"堀部 晃平","students":["山本 紘士朗", ...]}]
}
*/
const EWEB_SUBJECT_ABBR = {"数":"数学","英":"英語","国":"国語","理":"理科","社":"社会","化":"化学","物":"物理","生":"生物","地":"地学","現":"現代文","古":"古文","漢":"漢文","公":"公民"};
const EWEB_PS1_RE = /(?:PS\s*1|ＰＳ\s*１|1\s*対\s*1|１\s*対\s*１|一\s*対\s*一)(?!\d)/i;
function normalizeEwebSubjectText(raw){
return String(raw || "")
.replace(/&lt;/gi, "<")
.replace(/&gt;/gi, ">")
.replace(/[\uFF1C\u3008\u300A]/g, "<")
.replace(/[\uFF1E\u3009\u300B]/g, ">")
.replace(/\uFF08/g, "(")
.replace(/\uFF09/g, ")")
.replace(/[\u3000]+/g, " ")
.trim();
}
function parseEwebSubject(raw){
const s = normalizeEwebSubjectText(raw);
const m = s.match(/^(講|通)\s*[<\(\[【]([^>\)\]】]+)[>\)\]】]$/);
if(!m) return {subject: s, status: "normal"};
const kind = m[1], code = m[2].replace(/\s+/g, "");
const subject = EWEB_SUBJECT_ABBR[code] || code;
return {subject, status: kind === "講" ? "course" : "normal"};
}
/* 1対1は通＋山括弧。通(数)は1対2、講(数)は講習、集団は groups 側。
   全角の ＜国＞ や 〈国〉 も山括弧として扱う。 */
function isEwebSoloSubject(raw){
return /^通\s*<[^>]+>$/.test(normalizeEwebSubjectText(raw));
}
function isEwebPairSubject(raw){
return /^通\s*\([^)]+\)$/.test(normalizeEwebSubjectText(raw));
}
function ewebItemSubject(it){
if(!it) return "";
if(it.subject) return it.subject;
if(it.raw && it.raw.subject_name) return it.raw.subject_name;
if(it.subject_name) return it.subject_name;
return "";
}
function ewebPs1Texts(koma, it){
const out = [];
function add(v){ if(v != null && String(v) !== "") out.push(String(v)); }
function addTypeFields(obj){
if(!obj) return;
["name","type","type_name","class_type","class_type_name","lesson_type","lesson_form","form","form_name","style","style_name","kind","kind_name","ps","class_form","class_form_name"].forEach(k=> add(obj[k]));
}
if(koma){ add(koma.name); addTypeFields(koma); addTypeFields(koma.raw); }
if(it){ add(it.subject); add(it.subject_name); addTypeFields(it.raw); }
return out;
}
function looksLikeEwebPs1(koma, it){
return ewebPs1Texts(koma, it).some(t=> EWEB_PS1_RE.test(t));
}
/* 科目の山括弧を最優先。通(数)や講習は1対1にしない。
   科目に括弧がなくても、コマ名や種別が PS1 / 1対1 なら1対1。 */
function isEwebSoloItem(it, koma){
const rawSubj = ewebItemSubject(it);
const s = normalizeEwebSubjectText(rawSubj);
if(/^講\s*[<(【\[]/.test(s)) return false;
if(isEwebSoloSubject(rawSubj)) return true;
if(isEwebPairSubject(rawSubj)) return false;
return looksLikeEwebPs1(koma, it);
}
function ewebSoloDisplaySubject(raw){
const parsed = parseEwebSubject(raw);
if(parsed.subject && parsed.subject !== String(raw || "").trim()) return parsed.subject;
const m = normalizeEwebSubjectText(raw).match(/^通\s*<([^>]+)>$/);
if(!m) return parsed.subject;
return EWEB_SUBJECT_ABBR[m[1].replace(/\s+/g, "")] || m[1].replace(/\s+/g, "");
}
function ewebPayloadItems(payload){
return (payload && (payload.items || payload.schedules)) || [];
}
function soloMapFromEwebPayload(payload){
const map = {};
if(!payload) return map;
const komaMap = {};
(payload.komas||[]).forEach(k=> { if(k && k.id != null) komaMap[k.id] = k; });
ewebPayloadItems(payload).forEach(it=>{
const koma = komaMap[it.koma_id];
if(!isEwebSoloItem(it, koma)) return;
const name = it.student_name || "";
if(!name) return;
map[soloComboKey(name, ewebSoloDisplaySubject(ewebItemSubject(it)))] = 1;
});
return map;
}
function saveEwebSoloMap(dateStr, map){
if(!dateStr) return;
try{
const all = JSON.parse(STORAGE.getItem("seat-table-solo") || "{}") || {};
all[dateStr] = map || {};
STORAGE.setItem("seat-table-solo", JSON.stringify(all));
}catch(e){}
}
function guessSubjectFromName(name){
const s = name || "";
for(const [abbr, full] of Object.entries(EWEB_SUBJECT_ABBR)){
if(s.includes(full) || s.includes(abbr)) return full;
}
return "";
}
function buildDayFromEwebPayload(payload){
const komaMap = {};
(payload.komas||[]).forEach(k=> komaMap[k.id] = k);

// individual items grouped by koma -> teacher
const byKoma = {};
ewebPayloadItems(payload).forEach(it=>{
byKoma[it.koma_id] = byKoma[it.koma_id] || [];
byKoma[it.koma_id].push(it);
});
// groups grouped by koma
const groupsByKoma = {};
(payload.groups||[]).forEach(g=>{
groupsByKoma[g.koma_id] = groupsByKoma[g.koma_id] || [];
groupsByKoma[g.koma_id].push(g);
});

const komaIds = new Set([...Object.keys(byKoma), ...Object.keys(groupsByKoma)].map(Number));
const orderedKomaIds = Array.from(komaIds).sort((a,b)=>{
const sa = (komaMap[a] && komaMap[a].start) || "99:99";
const sb = (komaMap[b] && komaMap[b].start) || "99:99";
return sa.localeCompare(sb);
});

const blocks = orderedKomaIds.map(komaId=>{
const koma = komaMap[komaId] || {};
const block = { id: uid(), time: (koma.start && koma.end) ? `${koma.start}〜${koma.end}` : "時間を入力", seats: [], groupRows: [] };

const items = byKoma[komaId] || [];
const byTeacher = {};
items.forEach(it=>{
const key = it.teacher_name || "";
byTeacher[key] = byTeacher[key] || [];
byTeacher[key].push(it);
});
Object.keys(byTeacher).forEach(teacherNameRaw=>{
const teacherName = normalizeName(teacherNameRaw);
const list = byTeacher[teacherNameRaw].slice().sort((a,b)=> (a.pos||0)-(b.pos||0));
const solos = [], rest = [];
list.forEach(it=> { if(isEwebSoloItem(it, koma)) solos.push(it); else rest.push(it); });
function pushIndividualSeat(leftIt, rightIt){
const seat = emptySeat(block.seats.length+1);
seat.teacher = teacherName;
if(leftIt){
const p0 = parseEwebSubject(ewebItemSubject(leftIt));
seat.left = {student:normalizeName(leftIt.student_name||""), subject:p0.subject, grade:leftIt.grade||leftIt.student_grade||"", status:p0.status};
}
if(rightIt){
const p1 = parseEwebSubject(ewebItemSubject(rightIt));
seat.right = {student:normalizeName(rightIt.student_name||""), subject:p1.subject, grade:rightIt.grade||rightIt.student_grade||"", status:p1.status};
}
block.seats.push(seat);
}
/* PS1 / 通<科目> は1人で1席。同じ講師の別生徒と1対2にまとめない。 */
solos.forEach(it=> pushIndividualSeat(it, null));
if(rest[0]){
pushIndividualSeat(rest[0], rest[1] || null);
if(rest.length>2){
const p2 = parseEwebSubject(ewebItemSubject(rest[2]));
block.groupRows.push({
id: uid(), seatNumber: "", name: "", teacher: teacherName,
subject: p2.subject,
students: rest.slice(2).map(x=>normalizeName(x.student_name)).filter(Boolean)
});
}
}
});

(groupsByKoma[komaId]||[]).forEach(g=>{
block.groupRows.push({
id: uid(), seatNumber: "", name: g.name || "",
teacher: normalizeName(g.teacher_name || ""), subject: guessSubjectFromName(g.name),
students: (g.students||[]).map(n=>normalizeName(n)).filter(Boolean)
});
});

if(block.seats.length===0) block.seats.push(emptySeat(1));
return block;
});

return { blocks };
}

function openEwebImportModal(){
openModal(`
<h3>eWebから読み込み</h3>
<p>eWebの座席表ページ（取り込みたい日付を表示した状態）で、ブックマークレット「eWeb取込」をクリックすると、
その日の予定がクリップボードにコピーされます。それを下の欄に貼り付けてください。日付はデータに含まれる日付が自動で使われます。</p>
<textarea id="ewebPasteArea" placeholder="ここに貼り付け"></textarea>
<p class="sub" style="margin-top:8px;">まだブックマークレットを設定していない場合は、設定・バックアップタブの案内を参照してください。</p>
<div class="modal-actions">
<button class="btn" id="modalCancel">キャンセル</button>
<button class="btn primary" id="modalConfirm">取り込む</button>
</div>
`, (modal)=>{
modal.querySelector("#pasteAreaFocus");
modal.querySelector("#ewebPasteArea").focus();
modal.querySelector("#modalCancel").addEventListener("click", closeModal);
modal.querySelector("#modalConfirm").addEventListener("click", ()=>{
const raw = modal.querySelector("#ewebPasteArea").value.trim();
if(!raw){ showToast("貼り付けられたデータがありません", true); return; }
let payload;
try{ payload = JSON.parse(raw); }
catch(e){ showToast("JSONの読み込みに失敗しました。ブックマークレットでコピーした内容をそのまま貼り付けてください。", true); return; }
if(!payload.date){ showToast("日付情報が見つかりませんでした", true); return; }
const dateStr = payload.date;
const newDay = buildDayFromEwebPayload(payload);
closeModal();
confirmDialog(`${dateStr} の座席表を、eWebのデータで上書きします（既存の内容は消えます）。よろしいですか？`, ()=>{
state.days[dateStr] = newDay;
migrate(state);
currentDate = dateStr;
saveEwebSoloMap(dateStr, soloMapFromEwebPayload(payload));
const added = ensureRosterFromDay(newDay);
saveState();
renderTabs();
renderSeatView();
if(window.__repaintSolo){ try{ window.__repaintSolo(); }catch(e){} }
let msg = `${dateStr} の座席表をeWebから取り込みました`;
if(added.students || added.teachers){
const bits = [];
if(added.students) bits.push(`生徒${added.students}名`);
if(added.teachers) bits.push(`講師${added.teachers}名`);
msg += `（名簿に${bits.join("・")}を追加）`;
}
showToast(msg);
});
});
});
}

/* ---------------- confirm dialog ---------------- */
function confirmDialog(message, onConfirm){
openModal(`
<h3>確認</h3>
<p>${escapeHtml(message)}</p>
<div class="modal-actions">
<button class="btn" id="modalCancel">キャンセル</button>
<button class="btn primary" id="modalConfirm">実行する</button>
</div>
`, (modal)=>{
modal.querySelector("#modalCancel").addEventListener("click", closeModal);
modal.querySelector("#modalConfirm").addEventListener("click", ()=>{ closeModal(); onConfirm(); });
});
}

/* =========================================================
STUDENT ROSTER
========================================================= */
function renderStudentsView(){
const el = document.getElementById("view-students");
el.innerHTML = `
<div class="panel">
<p class="eyebrow">STUDENT ROSTER</p>
<h2 style="margin:4px 0 4px;">生徒名簿</h2>
<p class="sub" style="margin:0 0 10px;">表計算ソフトのように直接編集できます。</p>
<p class="roster-hint">
<span class="ok">✓ チェックした生徒をまとめて削除できます</span>
<span class="ok">✓ 生年月日が未登録の生徒も、欄をクリックして後から入力できます</span>
<span class="ok">✓ 見出しの▲▼または行の矢印で並び替えできます</span>
</p>
<div class="roster-toolbar">
<input type="search" id="studentSearch" placeholder="名前・学年・科目で検索" value="${escapeHtml(studentSearch)}">
<button class="btn" id="btnSortAiueo">五十音順に並び替え</button>
<button class="btn" id="btnPasteStudents">Excelから貼り付け</button>
<button class="btn primary" id="btnAddStudent">＋ 生徒を追加</button>
<button class="btn danger" id="btnDeleteSelectedStudents">選択した生徒を削除</button>
</div>
<div class="roster-table-wrap">
<table class="roster-table" id="studentTable">
<thead><tr>
<th style="width:32px;"><input type="checkbox" id="selAllStudents"></th>
<th class="num-col">No.</th>
<th style="width:36px;"></th>
<th>氏名</th>
<th>生年月日（後から入力可）</th>
<th>学年</th>
<th>主な科目</th>
<th></th>
</tr></thead>
<tbody id="studentRows"></tbody>
</table>
</div>
</div>
${subjectDatalist()}
`;

document.getElementById("studentSearch").addEventListener("input", (e)=>{
studentSearch = e.target.value;
renderStudentRows();
});
document.getElementById("btnSortAiueo").addEventListener("click", ()=>{
const col = jaCollator();
state.students.sort((a,b)=> col.compare(a.name, b.name));
saveState(); renderStudentRows();
});
document.getElementById("btnPasteStudents").addEventListener("click", ()=> openPasteModal("students"));
document.getElementById("btnAddStudent").addEventListener("click", ()=>{
studentSearch = "";
const searchEl = document.getElementById("studentSearch");
if(searchEl) searchEl.value = "";
state.students.push({id:uid(), name:"", birthdate:"", grade:"", subject:""});
saveState();
renderTabs();
renderStudentRows();
const nameInput = document.querySelector("#studentRows tr:last-child .js-s-name");
if(nameInput){
nameInput.scrollIntoView({block:"nearest"});
nameInput.focus();
}
});
document.getElementById("btnDeleteSelectedStudents").addEventListener("click", ()=>{
const ids = Array.from(document.querySelectorAll(".js-student-check:checked")).map(c=>c.dataset.id);
if(!ids.length){ showToast("削除する生徒を選択してください", true); return; }
confirmDialog(`選択した${ids.length}名を削除します。よろしいですか？`, ()=>{
state.students = state.students.filter(s=> !ids.includes(s.id));
saveState(); renderStudentRows();
});
});
document.getElementById("selAllStudents").addEventListener("change", (e)=>{
document.querySelectorAll(".js-student-check").forEach(c=> c.checked = e.target.checked);
});

renderStudentRows();
}

function renderStudentRows(){
const tbody = document.getElementById("studentRows");
const filtered = state.students
.map((s,i)=>({s,i}))
.filter(({s})=>{
if(!studentSearch) return true;
const q = studentSearch.toLowerCase();
return (s.name||"").toLowerCase().includes(q) || (s.grade||"").toLowerCase().includes(q) || (s.subject||"").toLowerCase().includes(q);
});

tbody.innerHTML = filtered.map(({s,i}, displayIdx)=>`
<tr draggable="true" data-index="${i}">
<td><input type="checkbox" class="js-student-check" data-id="${s.id}"></td>
<td class="num-col">${displayIdx+1}</td>
<td>
<span class="drag-handle" title="ドラッグで並び替え">⠿</span>
<span class="row-order">
<button type="button" class="js-s-up" ${i===0?"disabled":""}>▲</button>
<button type="button" class="js-s-down" ${i===state.students.length-1?"disabled":""}>▼</button>
</span>
</td>
<td><input type="text" class="js-s-name" value="${escapeHtml(s.name)}" placeholder="氏名"></td>
<td><input type="date" class="js-s-birth" value="${escapeHtml(s.birthdate)}"></td>
<td><input type="text" class="js-s-grade" value="${escapeHtml(s.grade)}" placeholder="学年"></td>
<td><input list="subjectList" class="js-s-subject" value="${escapeHtml(s.subject)}" placeholder="主な科目"></td>
<td><button class="btn danger js-s-del">削除</button></td>
</tr>
`).join("") || `<tr><td colspan="8" class="empty-note">該当する生徒がいません</td></tr>`;

tbody.querySelectorAll("tr").forEach(row=>{
const idx = Number(row.dataset.index);
row.querySelector(".js-s-name")?.addEventListener("input", e=>{ state.students[idx].name = e.target.value; saveState(); });
row.querySelector(".js-s-name")?.addEventListener("change", e=>{ state.students[idx].name = String(e.target.value || "").trim(); e.target.value = state.students[idx].name; saveState(); });
row.querySelector(".js-s-birth")?.addEventListener("change", e=>{ state.students[idx].birthdate = e.target.value; saveState(); });
row.querySelector(".js-s-grade")?.addEventListener("input", e=>{ state.students[idx].grade = e.target.value; saveState(); });
row.querySelector(".js-s-subject")?.addEventListener("change", e=>{ state.students[idx].subject = e.target.value; registerCustomSubject(e.target.value); saveState(); });
row.querySelector(".js-s-del")?.addEventListener("click", ()=>{
const usage = studentUsageCount(state.students[idx].name);
const doDelete = ()=>{ state.students.splice(idx,1); saveState(); renderStudentRows(); };
if(usage>0){
confirmDialog(`この生徒は現在 ${usage} 件の授業に登録されています。名簿から削除しても、既存の授業データはそのまま残ります（表示は名前のみになります）。削除しますか？`, doDelete);
} else {
doDelete();
}
});
row.querySelector(".js-s-up")?.addEventListener("click", ()=>{
if(idx>0){ [state.students[idx-1], state.students[idx]] = [state.students[idx], state.students[idx-1]]; saveState(); renderStudentRows(); }
});
row.querySelector(".js-s-down")?.addEventListener("click", ()=>{
if(idx<state.students.length-1){ [state.students[idx+1], state.students[idx]] = [state.students[idx], state.students[idx+1]]; saveState(); renderStudentRows(); }
});
row.addEventListener("dragstart", ()=> row.classList.add("dragging"));
row.addEventListener("dragend", ()=> row.classList.remove("dragging"));
row.addEventListener("dragover", (e)=>{ e.preventDefault(); row.classList.add("drag-over"); });
row.addEventListener("dragleave", ()=> row.classList.remove("drag-over"));
row.addEventListener("drop", (e)=>{
e.preventDefault(); row.classList.remove("drag-over");
const draggingRow = tbody.querySelector(".dragging");
if(!draggingRow || draggingRow===row) return;
const from = Number(draggingRow.dataset.index);
const to = Number(row.dataset.index);
const [item] = state.students.splice(from,1);
state.students.splice(to,0,item);
saveState(); renderStudentRows();
});
});
}

/* =========================================================
TEACHER ROSTER
========================================================= */
function renderTeachersView(){
const el = document.getElementById("view-teachers");
el.innerHTML = `
<div class="panel">
<p class="eyebrow">TEACHER ROSTER</p>
<h2 style="margin:4px 0 4px;">講師名簿</h2>
<p class="sub" style="margin:0 0 10px;">講師名と担当可能科目を登録します。座席表の担当講師欄は、ここに登録された講師だけが選択できます。</p>
<div class="roster-toolbar">
<button class="btn" id="btnSortAiueoT">五十音順に並び替え</button>
<button class="btn" id="btnPasteTeachers">Excelから貼り付け</button>
<button class="btn primary" id="btnAddTeacher">＋ 講師を追加</button>
</div>
<div class="roster-table-wrap">
<table class="roster-table" id="teacherTable">
<thead><tr>
<th class="num-col">No.</th>
<th style="width:36px;"></th>
<th>講師名</th>
<th>担当可能科目</th>
<th>メモ</th>
<th></th>
</tr></thead>
<tbody id="teacherRows"></tbody>
</table>
</div>
</div>
`;
document.getElementById("btnSortAiueoT").addEventListener("click", ()=>{
const col = jaCollator();
state.teachers.sort((a,b)=> col.compare(a.name, b.name));
saveState(); renderTeacherRows();
});
document.getElementById("btnPasteTeachers").addEventListener("click", ()=> openPasteModal("teachers"));
document.getElementById("btnAddTeacher").addEventListener("click", ()=>{
state.teachers.push({id:uid(), name:"", subjects:"", note:""});
saveState(); renderTeacherRows();
});
renderTeacherRows();
}

function renderTeacherRows(){
const tbody = document.getElementById("teacherRows");
tbody.innerHTML = state.teachers.map((t,i)=>`
<tr draggable="true" data-index="${i}">
<td class="num-col">${i+1}</td>
<td>
<span class="drag-handle">⠿</span>
<span class="row-order">
<button type="button" class="js-t-up" ${i===0?"disabled":""}>▲</button>
<button type="button" class="js-t-down" ${i===state.teachers.length-1?"disabled":""}>▼</button>
</span>
</td>
<td><input type="text" class="js-t-name" value="${escapeHtml(t.name)}" placeholder="講師名"></td>
<td><input type="text" class="js-t-subjects" value="${escapeHtml(t.subjects)}" placeholder="例：数学・英語"></td>
<td><input type="text" class="js-t-note" value="${escapeHtml(t.note)}" placeholder="メモ"></td>
<td><button class="btn danger js-t-del">削除</button></td>
</tr>
`).join("") || `<tr><td colspan="6" class="empty-note">講師が登録されていません</td></tr>`;

tbody.querySelectorAll("tr").forEach(row=>{
const idx = Number(row.dataset.index);
row.querySelector(".js-t-name")?.addEventListener("input", e=>{ state.teachers[idx].name = e.target.value; saveState(); });
row.querySelector(".js-t-subjects")?.addEventListener("input", e=>{ state.teachers[idx].subjects = e.target.value; saveState(); });
row.querySelector(".js-t-note")?.addEventListener("input", e=>{ state.teachers[idx].note = e.target.value; saveState(); });
row.querySelector(".js-t-del")?.addEventListener("click", ()=>{
const usage = teacherUsageCount(state.teachers[idx].name);
const doDelete = ()=>{ state.teachers.splice(idx,1); saveState(); renderTeacherRows(); };
if(usage>0){
confirmDialog(`この講師は現在 ${usage} 件の授業枠に割り当てられています。名簿から削除すると、座席表側の担当講師欄は「未設定」として扱われます。削除しますか？`, doDelete);
} else {
doDelete();
}
});
row.querySelector(".js-t-up")?.addEventListener("click", ()=>{
if(idx>0){ [state.teachers[idx-1], state.teachers[idx]] = [state.teachers[idx], state.teachers[idx-1]]; saveState(); renderTeacherRows(); }
});
row.querySelector(".js-t-down")?.addEventListener("click", ()=>{
if(idx<state.teachers.length-1){ [state.teachers[idx+1], state.teachers[idx]] = [state.teachers[idx], state.teachers[idx+1]]; saveState(); renderTeacherRows(); }
});
row.addEventListener("dragstart", ()=> row.classList.add("dragging"));
row.addEventListener("dragend", ()=> row.classList.remove("dragging"));
row.addEventListener("dragover", (e)=>{ e.preventDefault(); row.classList.add("drag-over"); });
row.addEventListener("dragleave", ()=> row.classList.remove("drag-over"));
row.addEventListener("drop", (e)=>{
e.preventDefault(); row.classList.remove("drag-over");
const draggingRow = tbody.querySelector(".dragging");
if(!draggingRow || draggingRow===row) return;
const from = Number(draggingRow.dataset.index);
const to = Number(row.dataset.index);
const [item] = state.teachers.splice(from,1);
state.teachers.splice(to,0,item);
saveState(); renderTeacherRows();
});
});
}

/* ---------------- paste from Excel (shared) ---------------- */
function openPasteModal(kind){
const label = kind==="students" ? "生徒名簿" : "講師名簿";
const cols = kind==="students" ? "氏名 / 生年月日(YYYY-MM-DD, 省略可) / 学年 / 主な科目" : "講師名 / 担当可能科目 / メモ";
openModal(`
<h3>${label}へExcelから貼り付け</h3>
<p>Excel・スプレッドシートで複数行・複数列を選択してコピーし、下の欄に貼り付けてください。列の並びは「${cols}」です。列が足りない場合は空欄として扱われます。</p>
<textarea id="pasteArea" placeholder="ここに貼り付け"></textarea>
<div class="modal-actions">
<button class="btn" id="modalCancel">キャンセル</button>
<button class="btn primary" id="modalConfirm">取り込む</button>
</div>
`, (modal)=>{
modal.querySelector("#pasteArea").focus();
modal.querySelector("#modalCancel").addEventListener("click", closeModal);
modal.querySelector("#modalConfirm").addEventListener("click", ()=>{
const raw = modal.querySelector("#pasteArea").value;
const rows = parsePasteData(raw);
if(!rows.length){ showToast("貼り付けられたデータがありません", true); return; }
let added = 0;
rows.forEach(cols=>{
if(kind==="students"){
const name = normalizeName(cols[0]);
if(!name) return;
state.students.push({id:uid(), name, birthdate: normalizeDate(cols[1]||""), grade: (cols[2]||"").trim(), subject:(cols[3]||"").trim()});
} else {
const name = normalizeName(cols[0]);
if(!name) return;
state.teachers.push({id:uid(), name, subjects:(cols[1]||"").trim(), note:(cols[2]||"").trim()});
}
added++;
});
saveState();
closeModal();
if(kind==="students") renderStudentsView(); else { try { renderTeachersView(); } catch(e){} }
showToast(`${added}件を追加しました`);
});
});
}
function parsePasteData(raw){
return raw.split(/\r\n|\r|\n/)
.map(line=> line.trim())
.filter(line=> line.length>0)
.map(line=> line.split("\t").map(c=> normalizeName(c)));
}
function normalizeName(str){
if(str==null) return "";
// normalize full-width spaces to single half-width, collapse repeats, trim
return String(str).replace(/[\u3000\s]+/g," ").trim();
}
function normalizeDate(str){
const s = (str||"").trim();
if(!s) return "";
const m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
if(m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
return s;
}

/* =========================================================
PRINT PREVIEW
========================================================= */
function applyPrintCssVars(){
const ps = state.printSettings;
document.documentElement.style.setProperty("--print-subject-size", ps.subjectSize + "pt");
document.documentElement.style.setProperty("--print-student-size", ps.studentSize + "pt");
document.documentElement.style.setProperty("--print-grade-size", ps.gradeSize + "pt");
}

function imagesHtml(){
return (state.printSettings.images||[]).map(img=>`
<img class="print-image" data-img-id="${img.id}" src="${img.src}" draggable="false"
style="left:${img.xPct}%; top:${img.yPct}%; width:${img.widthPct}%; opacity:${img.opacity};">
`).join("");
}

function resizeImageDataUrl(dataUrl, maxDim, cb){
const img = new Image();
img.onload = ()=>{
let width = img.width, height = img.height;
if(width > maxDim || height > maxDim){
const scale = maxDim / Math.max(width, height);
width = Math.round(width*scale); height = Math.round(height*scale);
}
const canvas = document.createElement("canvas");
canvas.width = width; canvas.height = height;
canvas.getContext("2d").drawImage(img, 0, 0, width, height);
cb(canvas.toDataURL("image/jpeg", 0.85));
};
img.src = dataUrl;
}

function addImageFile(file){
if(!file || file.type.indexOf("image") === -1){ showToast("画像ファイルを選択してください", true); return; }
const reader = new FileReader();
reader.onload = ()=>{
resizeImageDataUrl(reader.result, 900, (resized)=>{
const count = state.printSettings.images.length;
state.printSettings.images.push({
id: uid(), src: resized,
xPct: 8 + (count % 5) * 6, yPct: 8 + (count % 5) * 6,
widthPct: 18, opacity: 1
});
saveState();
renderPrintPreviewView();
showToast("画像を追加しました");
});
};
reader.readAsDataURL(file);
}

function initPastePreview(){
document.addEventListener("paste", (e)=>{
if(currentTab !== "print") return;
const items = e.clipboardData && e.clipboardData.items;
if(!items) return;
for(const item of items){
if(item.type.indexOf("image") !== -1){
addImageFile(item.getAsFile());
e.preventDefault();
break;
}
}
});
}

function bindImageDrag(){
const page = document.getElementById("previewPage");
if(!page) return;
let dragging = null;
page.querySelectorAll(".print-image").forEach(imgEl=>{
imgEl.style.cursor = "move";
imgEl.addEventListener("pointerdown", (e)=>{
dragging = imgEl.dataset.imgId;
imgEl.setPointerCapture(e.pointerId);
});
});
page.addEventListener("pointermove", (e)=>{
if(!dragging) return;
const rect = page.getBoundingClientRect();
let xPct = ((e.clientX - rect.left) / rect.width) * 100;
let yPct = ((e.clientY - rect.top) / rect.height) * 100;
xPct = Math.max(0, Math.min(95, xPct));
yPct = Math.max(0, Math.min(95, yPct));
const imgData = state.printSettings.images.find(i=>i.id === dragging);
if(imgData){
imgData.xPct = Math.round(xPct*10)/10;
imgData.yPct = Math.round(yPct*10)/10;
const el = page.querySelector(`.print-image[data-img-id="${dragging}"]`);
if(el){ el.style.left = imgData.xPct + "%"; el.style.top = imgData.yPct + "%"; }
}
});
page.addEventListener("pointerup", ()=>{
if(dragging) saveState();
dragging = null;
});
}

function formatJaDateLabel(dateStr){
const wd = weekdayOf(dateStr);
const d = new Date(dateStr+"T00:00:00");
if(isNaN(d.getTime())) return dateStr;
return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${WEEKDAY_LABELS[wd]}）`;
}

function dayHasPrintableContent(day){
if(!day || !Array.isArray(day.blocks) || !day.blocks.length) return false;
return day.blocks.some(block=>{
if(!block) return false;
if(block.time && block.time !== "時間を入力" && /[0-9]/.test(block.time)) return true;
if((block.groupRows || []).some(g=> g && (g.name || g.teacher || g.subject || (g.students && g.students.length)))) return true;
return (block.seats || []).some(seat=>{
if(!seat) return false;
if(seat.teacher) return true;
const left = seat.left || {};
const right = seat.right || {};
return !!(left.student || left.subject || right.student || right.subject);
});
});
}

function listPrintableDates(){
return Object.keys(state.days || {}).filter(dateStr=> dayHasPrintableContent(state.days[dateStr])).sort();
}

function datesInRange(dates, start, end){
return dates.filter(dateStr=>{
if(start && dateStr < start) return false;
if(end && dateStr > end) return false;
return true;
});
}

function printDayPageHtml(dateStr){
const day = state.days[dateStr];
if(!day) return "";
const blocks = (day.blocks || []).map((block, bi)=> blockHtml(block, bi, dateStr)).join("");
return `<div class="print-preview-page multi-print-page" data-solo-date="${escapeHtml(dateStr)}">
${imagesHtml()}
<div class="page-head" style="margin-bottom:4mm;">
<h2 style="font-size:16pt;margin:0;">${escapeHtml(formatJaDateLabel(dateStr))}</h2>
</div>
<div class="blocks preview-blocks">${blocks || `<div class="empty-note">この日の授業枠はありません。</div>`}</div>
</div>`;
}

function runMultiDayPrint(dates){
const root = document.getElementById("multiDayPrint");
if(!root || !dates.length) return;
root.innerHTML = dates.map(printDayPageHtml).join("");
document.body.classList.add("multi-day-print");
if(window.__repaintSolo){ try{ window.__repaintSolo(); }catch(e){} }
const cleanup = ()=>{
document.body.classList.remove("multi-day-print");
root.innerHTML = "";
window.removeEventListener("afterprint", cleanup);
};
window.addEventListener("afterprint", cleanup);
requestAnimationFrame(function(){
requestAnimationFrame(function(){
if(window.__fitPrintToPaper){ try{ window.__fitPrintToPaper(); }catch(e){} }
window.print();
});
});
}

function openMultiDayPrintModal(){
const allDates = listPrintableDates();
if(!allDates.length){
showToast("印刷できる座席表データがありません", true);
return;
}
const displayed = currentDate;
const defaultStart = displayed;
const defaultEnd = displayed;
openModal(`
<h3>複数日を印刷</h3>
<p>データがある日付だけを表示しています。空の日付は含まれません。1日につき1ページで、日付順に印刷します。</p>
<div class="multi-print-range">
<label>開始日 <input type="date" id="multiPrintStart" value="${defaultStart}"></label>
<label>終了日 <input type="date" id="multiPrintEnd" value="${defaultEnd}"></label>
</div>
<div class="multi-print-summary" id="multiPrintSummary"></div>
<div class="multi-date-list" id="multiDateList"></div>
<div class="modal-actions">
<button class="btn" id="modalCancel">キャンセル</button>
<button class="btn primary" id="modalConfirm">印刷する</button>
</div>
`, (modal)=>{
const startEl = modal.querySelector("#multiPrintStart");
const endEl = modal.querySelector("#multiPrintEnd");
const listEl = modal.querySelector("#multiDateList");
const summaryEl = modal.querySelector("#multiPrintSummary");
const confirmBtn = modal.querySelector("#modalConfirm");
const refreshList = ()=>{
const start = startEl.value;
const end = endEl.value;
if(start && end && start > end){
listEl.innerHTML = `<p class="sub">開始日が終了日より後になっています。</p>`;
summaryEl.textContent = "対象 0日 / 印刷 0ページ";
confirmBtn.disabled = true;
return;
}
const visible = datesInRange(allDates, start, end);
if(!visible.length){
listEl.innerHTML = `<p class="sub">この期間に印刷できる日付はありません。</p>`;
summaryEl.textContent = "対象 0日 / 印刷 0ページ";
confirmBtn.disabled = true;
return;
}
listEl.innerHTML = visible.map(dateStr=>`
<label class="opt"><input type="checkbox" class="js-multi-date" value="${escapeHtml(dateStr)}" checked>
<span>${escapeHtml(formatJaDateLabel(dateStr))}</span></label>
`).join("");
updateSummary();
};
const selectedDates = ()=> Array.from(listEl.querySelectorAll(".js-multi-date:checked")).map(el=> el.value).sort();
const updateSummary = ()=>{
const n = selectedDates().length;
summaryEl.textContent = `対象 ${n}日 / 印刷 ${n}ページ（1日1ページ）`;
confirmBtn.disabled = n === 0;
};
listEl.addEventListener("change", updateSummary);
startEl.addEventListener("change", refreshList);
endEl.addEventListener("change", refreshList);
refreshList();
modal.querySelector("#modalCancel").addEventListener("click", closeModal);
confirmBtn.addEventListener("click", ()=>{
const dates = selectedDates();
if(!dates.length){ showToast("印刷する日付を選んでください", true); return; }
closeModal();
setTimeout(()=> runMultiDayPrint(dates), 50);
});
});
}

function renderPrintPreviewView(){
const el = document.getElementById("view-print");
const ps = state.printSettings;
const day = getOrCreateDay(currentDate);

const imageRows = ps.images.map((img,i)=>`
<div class="image-row" data-img-index="${i}">
<img class="image-thumb" src="${img.src}">
<div class="image-row-controls">
<label>大きさ <input type="range" class="js-img-size" min="4" max="60" step="1" value="${img.widthPct}"></label>
<label>不透明度 <input type="range" class="js-img-opacity" min="5" max="100" step="5" value="${Math.round(img.opacity*100)}"></label>
</div>
<button type="button" class="btn danger js-img-remove">削除</button>
</div>
`).join("");

el.innerHTML = `
<div class="panel page-head">
<p class="eyebrow">PRINT PREVIEW</p>
<h2>印刷プレビュー</h2>
<p class="sub">実際に印刷される見た目を確認しながら、文字の大きさや画像の位置を調整できます。ここでの設定はすべての日の印刷に共通して使われます。画像はプレビュー内でドラッグして好きな場所に置けます。</p>
<div class="seat-toolbar">
<label class="date-field">プレビューする日付
<input type="date" id="previewDatePicker" value="${currentDate}">
</label>
<div class="btn-row">
<button class="btn primary" id="btnPrintFromPreview">この内容で印刷する</button>
<button class="btn" id="btnPrintMultiFromPreview">複数日を印刷</button>
</div>
</div>
</div>

<div class="panel print-settings-panel">
<h3>文字の大きさ</h3>
<div class="slider-row">
<label>科目 <span id="valSubjectSize">${ps.subjectSize}</span>pt</label>
<input type="range" id="rangeSubjectSize" min="10" max="24" step="0.5" value="${ps.subjectSize}">
</div>
<div class="slider-row">
<label>生徒名 <span id="valStudentSize">${ps.studentSize}</span>pt</label>
<input type="range" id="rangeStudentSize" min="7" max="16" step="0.5" value="${ps.studentSize}">
</div>
<div class="slider-row">
<label>学年 <span id="valGradeSize">${ps.gradeSize}</span>pt</label>
<input type="range" id="rangeGradeSize" min="6" max="12" step="0.5" value="${ps.gradeSize}">
</div>

<h3 style="margin-top:18px;">画像（ロゴ・背景など）</h3>
<p class="sub" style="margin:0 0 8px;">複数枚まで追加できます。アップロード、またはこの画面の上でそのまま貼り付け（Ctrl+V / Cmd+V）してください。プレビュー内の画像は、ドラッグして好きな場所に動かせます。</p>
<div class="btn-row" style="margin-bottom:10px;">
<input type="file" id="imageFile" accept="image/*" style="max-width:220px;">
</div>
<div class="image-list">${imageRows}</div>
</div>

<div class="print-preview-wrap">
<div class="print-preview-page" id="previewPage" data-solo-date="${escapeHtml(currentDate)}">
${imagesHtml()}
<div class="page-head" style="margin-bottom:4mm;">
<h2 style="font-size:16pt;margin:0;">${(()=>{ const d=new Date(currentDate+"T00:00:00"); return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${WEEKDAY_LABELS[weekdayOf(currentDate)]}）`; })()}</h2>
</div>
<div class="blocks preview-blocks" id="previewBlocks">
${day.blocks.map((block,bi)=> blockHtml(block, bi, currentDate)).join("")}
</div>
</div>
</div>
`;

applyPrintCssVars();
bindImageDrag();
if(window.__repaintSolo){ try{ window.__repaintSolo(); }catch(e){} }
if(window.__syncPrintPreview){ try{ window.__syncPrintPreview(); }catch(e){} }

document.getElementById("previewDatePicker").addEventListener("change", (e)=>{
currentDate = e.target.value || todayStr();
renderPrintPreviewView();
});
document.getElementById("btnPrintFromPreview").addEventListener("click", ()=> runMultiDayPrint([currentDate]));
document.getElementById("btnPrintMultiFromPreview").addEventListener("click", openMultiDayPrintModal);
document.getElementById("rangeSubjectSize").addEventListener("input", (e)=>{
ps.subjectSize = Number(e.target.value);
document.getElementById("valSubjectSize").textContent = ps.subjectSize;
applyPrintCssVars(); saveState();
});
document.getElementById("rangeStudentSize").addEventListener("input", (e)=>{
ps.studentSize = Number(e.target.value);
document.getElementById("valStudentSize").textContent = ps.studentSize;
applyPrintCssVars(); saveState();
});
document.getElementById("rangeGradeSize").addEventListener("input", (e)=>{
ps.gradeSize = Number(e.target.value);
document.getElementById("valGradeSize").textContent = ps.gradeSize;
applyPrintCssVars(); saveState();
});
document.getElementById("imageFile").addEventListener("change", (e)=>{
Array.from(e.target.files || []).forEach(f=> addImageFile(f));
e.target.value = "";
});
document.querySelectorAll(".image-row").forEach(row=>{
const idx = Number(row.dataset.imgIndex);
row.querySelector(".js-img-size").addEventListener("input", (e)=>{
ps.images[idx].widthPct = Number(e.target.value);
const imgEl = document.querySelector(`.print-image[data-img-id="${ps.images[idx].id}"]`);
if(imgEl) imgEl.style.width = ps.images[idx].widthPct + "%";
saveState();
});
row.querySelector(".js-img-opacity").addEventListener("input", (e)=>{
ps.images[idx].opacity = Number(e.target.value)/100;
const imgEl = document.querySelector(`.print-image[data-img-id="${ps.images[idx].id}"]`);
if(imgEl) imgEl.style.opacity = ps.images[idx].opacity;
saveState();
});
row.querySelector(".js-img-remove").addEventListener("click", ()=>{
ps.images.splice(idx,1);
saveState(); renderPrintPreviewView();
});
});
}

/* =========================================================
SETTINGS / BACKUP
========================================================= */
const EWEB_BOOKMARKLET = `javascript:(async()=>{window.focus();const m=location.pathname.match(/schoolDay\\/(\\d+)/);const schoolId=m?m[1]:null;const dateInput=document.querySelector('input[type=date]');const date=dateInput?dateInput.value:null;if(!schoolId||!date){alert('学校IDまたは日付が取得できませんでした');return;}try{const res=await window.axios.post('/api/schedule/getSchoolSchedules/'+schoolId+'/'+date+'/'+date);const data=res.data;const komas=(data.date_komas||[]).flatMap(dk=>(dk.koma_set&&dk.koma_set.komas)||[]).map(k=>({id:k.id,name:k.name,start:k.start,end:k.end,raw:Object.keys(k).reduce(function(o,key){var v=k[key];if(v===null||typeof v!=="object")o[key]=v;return o;},{})}));const items=(data.schedules||[]).map(s=>({koma_id:s.koma_id,teacher_name:s.teacher_name,student_name:s.student_name,grade:s.student_grade,subject:s.subject_name,pos:s.pos,flags:Object.keys(s).filter(function(k){return /\u632f\u66ff/.test(String(s[k]))}).map(function(k){return k+"="+String(s[k]).slice(0,40)}),raw:Object.keys(s).reduce(function(o,k){var v=s[k];if(v===null||typeof v!=="object"){if(k!=="student_name"&&k!=="teacher_name")o[k]=v;}return o;},{})}));const groups=(data.scheduleGroups||[]).map(g=>({koma_id:g.koma_id,start:g.start,end:g.end,name:g.group_class?g.group_class.name:'',teacher_name:(g.join_teachers&&g.join_teachers[0]&&g.join_teachers[0].teacher&&g.join_teachers[0].teacher.user)?g.join_teachers[0].teacher.user.name:'',students:(g.join_students||[]).map(js=>js.student?js.student.name:'').filter(Boolean)}));const payload={date,komas,items,groups};const json=JSON.stringify(payload);let copied=false;try{await navigator.clipboard.writeText(json);copied=true;}catch(e){copied=false;}if(copied){alert(date+' の予定を座席表アプリ用にコピーしました（個別'+items.length+'件／集団'+groups.length+'件）。座席表アプリの「eWebから読み込む」ボタンに貼り付けてください。');}else{window.prompt('自動コピーに失敗しました。下のテキストを全選択（Ctrl+A/Cmd+A）してコピーし、座席表アプリの「eWebから読み込む」に貼り付けてください：',json);}}catch(err){alert('取得に失敗しました: '+(err.response?err.response.status:err.message));}})();`;

function isValidGoogleWebAppUrl(url){
url = String(url || "").trim();
return /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/.test(url);
}
function openGoogleSetupModal(){
const cfg = getGoogleBackupConfig() || { webAppUrl: "", token: "" };
openModal(`
<h3>Google自動バックアップの設定</h3>
<p class="sub">WebアプリURLと合言葉を、この端末に保存します。教室IDは固定で、別教室には変更できません。先生のGoogleログインは不要です。</p>
<label>教室ID
<input type="text" id="googleClassroomId" value="${escapeHtml(CLASSROOM_ID)}" readonly style="width:100%;border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0 12px;background:#f5f7fb;">
</label>
<label>WebアプリURL
<input type="url" id="googleWebAppUrl" value="${escapeHtml(cfg.webAppUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0 12px;">
</label>
<label>合言葉
<input type="password" id="googleBackupToken" value="" placeholder="${cfg.token ? "（変更する場合のみ入力）" : "Apps Scriptに設定した合言葉"}" autocomplete="off" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0 12px;">
</label>
<div class="modal-actions">
<button class="btn" id="modalCancel">キャンセル</button>
<button class="btn primary" id="modalConfirm">保存する</button>
</div>
`, (modal)=>{
modal.querySelector("#modalCancel").addEventListener("click", closeModal);
modal.querySelector("#modalConfirm").addEventListener("click", ()=>{
const url = modal.querySelector("#googleWebAppUrl").value.trim();
let token = modal.querySelector("#googleBackupToken").value;
if(modal.querySelector("#googleClassroomId").value !== CLASSROOM_ID){
showToast("教室IDは変更できません", true); return;
}
if(!isValidGoogleWebAppUrl(url)){ showToast("WebアプリURLの形式が正しくありません", true); return; }
if(!token) token = cfg.token;
if(!token){ showToast("合言葉を入力してください", true); return; }
saveGoogleBackupConfig(url, token);
closeModal();
showToast("この教室のGoogleバックアップ設定を保存しました");
if(currentTab === "settings") renderSettingsView();
runGoogleBackup(true);
});
});
}
function restoreFromGoogleBackup(){
confirmDialog("Googleに保存された最新バックアップで、この端末の座席表・名簿・設定を置き換えます。現在この端末にのみある変更は失われます。", ()=>{
if(!getGoogleBackupConfig()){ showToast("先にGoogleバックアップを設定してください", true); return; }
showToast("Googleから復元しています…");
postGoogleBackupApi("restore").then(data=>{
if(data.classroomId && data.classroomId !== CLASSROOM_ID){
showToast("別教室のバックアップは復元できません", true);
return;
}
if(!data.json || typeof data.json !== "object"){ showToast("復元データが空でした", true); return; }
state = migrate(data.json);
saveState();
showToast("復元しました。画面を再読み込みします");
setTimeout(()=>{ location.reload(); }, 400);
}).catch(err=>{
showToast(googleErrorMessage(err && err.message), true);
});
});
}

function renderSettingsView(){
const el = document.getElementById("view-settings");
el.innerHTML = `
<div class="panel page-head">
<p class="eyebrow">SETTINGS</p>
<h2>設定・バックアップ</h2>
<p class="sub">すべてのデータ（生徒名簿・講師名簿・座席配置・週ごとの座席表・曜日プリセット）をまとめてバックアップ・復元できます。</p>
</div>
<div class="panel settings-card" style="grid-column:1/-1;">
<h3>Google授業履歴</h3>
<p>座席表・名簿・設定を、この教室専用のGoogleドライブへ自動保存します。座席表画面の「授業履歴」から過去の記録を確認できます。先生のGoogleログインは不要です。</p>
<p><strong>教室ID：</strong><code>${escapeHtml(CLASSROOM_ID)}</code>（固定。別教室には変更できません）</p>
<p><strong>WebアプリURL：</strong>${getGoogleBackupConfig() ? escapeHtml(getGoogleBackupConfig().webAppUrl) : "未設定"}</p>
<p><strong>合言葉：</strong>${getGoogleBackupConfig() ? "この端末に保存済み" : "未設定"}</p>
<div id="googleBackupStatusBox">${googleBackupStatusHtml(loadGoogleBackupStatus())}</div>
<div class="btn-row" style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;">
<button class="btn" id="btnGoogleBackupSetup">設定する</button>
<button class="btn" id="btnGoogleBackupNow">今すぐ履歴保存</button>
<button class="btn primary" id="btnGoogleBackupRestore">最新履歴から復元</button>
</div>
</div>
<div class="settings-grid">
<div class="panel settings-card">
<h3>バックアップを保存</h3>
<p>現在のすべてのデータを1つのJSONファイルとしてダウンロードします。定期的な保存をおすすめします。</p>
<button class="btn primary" id="btnExport">JSONをダウンロード</button>
</div>
<div class="panel settings-card">
<h3>バックアップから復元</h3>
<p>以前ダウンロードしたJSONファイルを読み込みます。現在のデータに<strong>上書き</strong>されるため、必要であれば先に上のボタンでバックアップしてください。</p>
<input type="file" id="importFile" accept="application/json,.json">
<div class="file-drop">JSONファイルを選択してください</div>
</div>
<div class="panel settings-card">
<h3>保存状況</h3>
<p>生徒：${state.students.length}名 / 講師：${state.teachers.length}名 / 登録日数：${Object.keys(state.days).length}日 / 曜日プリセット：${Object.keys(state.weekdayPresets).length}件</p>
<p>データはこの端末のブラウザ内（localStorage）に自動保存されています。ブラウザのデータを消去すると失われるため、バックアップの保存をおすすめします。</p>
</div>
<div class="panel settings-card" style="grid-column:1/-1;">
<h3>eWeb取込ブックマークレットの設定方法</h3>
<p>eWebから座席表を読み込むには、以下のリンクをブラウザの「ブックマークバー」にドラッグ＆ドロップして登録してください（クリックではなく、ドラッグで登録します）。</p>
<p style="margin:10px 0;"><a href="${escapeHtml(EWEB_BOOKMARKLET)}" onclick="alert('このリンクはブックマークバーへドラッグして登録してください。クリックではこのアプリ上では動作しません。');return false;" class="btn primary" style="text-decoration:none; display:inline-block;">📌 eWeb取込（ブックマークバーへドラッグ）</a></p>
<p>使い方：①eWebで取り込みたい日付の座席表画面を開く　②上のブックマークレットをクリック（コピー完了のメッセージが出ます）　③この座席表アプリに戻り、「eWebから読み込む」ボタンに貼り付け</p>
</div>
</div>
`;
document.getElementById("btnGoogleBackupSetup").addEventListener("click", openGoogleSetupModal);
document.getElementById("btnGoogleBackupNow").addEventListener("click", ()=>{
if(!getGoogleBackupConfig()){ showToast("先に「設定する」からURLと合言葉を保存してください", true); return; }
showToast("Googleへバックアップしています…");
runGoogleBackup(true).then(()=>{
const s = loadGoogleBackupStatus();
if(s.phase === "error") showToast(googleErrorMessage(s.lastError), true);
else showToast("Googleへバックアップしました");
});
});
document.getElementById("btnGoogleBackupRestore").addEventListener("click", restoreFromGoogleBackup);
document.getElementById("btnExport").addEventListener("click", ()=>{
const blob = new Blob([JSON.stringify(state, null, 2)], {type:"application/json"});
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
const stamp = todayStr();
a.href = url; a.download = `seat-table-backup-${stamp}.json`;
document.body.appendChild(a); a.click(); a.remove();
showToast("バックアップをダウンロードしました");
});
document.getElementById("importFile").addEventListener("change", (e)=>{
const file = e.target.files[0];
if(!file) return;
const reader = new FileReader();
reader.onload = ()=>{
try{
const parsed = JSON.parse(reader.result);
confirmDialog("バックアップを読み込みます。現在のデータは上書きされます。よろしいですか？", ()=>{
state = migrate(parsed);
saveState();
renderTabs();
renderCurrentView();
showToast("バックアップを読み込みました");
});
}catch(err){
showToast("ファイルの読み込みに失敗しました。正しいJSONファイルか確認してください。", true);
}
};
reader.readAsText(file);
});
}

/* =========================================================
INIT
========================================================= */
function init(){
state = loadState();
applyPrintCssVars();
initTabs();
initPastePreview();
renderTabs();
renderCurrentView();
applyGoogleBackupUi();
}
document.addEventListener("DOMContentLoaded", init);

/* ==========================================================
   印刷: 全体の大きさスライダー
   CSS変数 --print-page-scale を上下させて紙面の縮尺を変える。
   値は localStorage("seat-table-print-scale") に単独で保存する
   （本体の state を上書きしないため）。
   ========================================================== */
(function(){
  var KEY = "seat-table-print-scale";
  var MIN = 60, MAX = 180;
  function read(){
    var v = parseFloat(STORAGE.getItem(KEY));
    if (!isFinite(v) || v < MIN/100 || v > MAX/100) return 1;
    return v;
  }
  function apply(v){
    document.documentElement.style.setProperty("--print-page-scale", String(v));
  }
  function text(v){ return "全体の大きさ " + Math.round(v*100) + "%"; }
  function inject(){
    var panel = document.querySelector(".print-settings-panel");
    if (!panel || panel.querySelector("#printPageScale")) return;
    var labels = Array.prototype.slice.call(panel.querySelectorAll("label"));
    var anchor = null;
    for (var i = 0; i < labels.length; i++){
      if (labels[i].textContent.indexOf("学年") === 0){ anchor = labels[i].parentElement; break; }
    }
    var row = document.createElement("div");
    if (anchor) row.className = anchor.className;
    var lab = document.createElement("label");
    var input = document.createElement("input");
    input.type = "range";
    input.id = "printPageScale";
    input.min = String(MIN); input.max = String(MAX); input.step = "5";
    var v = read();
    input.value = String(Math.round(v*100));
    lab.textContent = text(v);
    input.addEventListener("input", function(){
      var nv = parseInt(input.value, 10) / 100;
      try { STORAGE.setItem(KEY, String(nv)); } catch(e){}
      apply(nv);
      lab.textContent = text(nv);
      if (window.__syncPrintPreview){ try{ window.__syncPrintPreview(); }catch(e){} }
    });
    row.appendChild(lab);
    row.appendChild(input);
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(row, anchor.nextSibling);
    else panel.appendChild(row);
  }
  apply(read());
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
  setInterval(function(){ try { inject(); } catch(e){} }, 1500);
})();

/* ==========================================================
   印刷: 行の高さ（縦の伸ばし）と、プレビューの画面フィット表示
   ========================================================== */
(function(){
  var ROWKEY = "seat-table-print-row-h";
  var FITKEY = "seat-table-preview-fit";
  var MAXMM = 30;
  function q(s){ return document.querySelector(s); }

  function readRow(){
    var v = parseFloat(STORAGE.getItem(ROWKEY));
    if (!isFinite(v) || v < 0 || v > MAXMM) return 0;
    return v;
  }
  function applyRow(v){
    document.documentElement.style.setProperty("--print-row-h", v > 0 ? (v + "mm") : "0px");
  }
  function rowText(v){ return v > 0 ? ("行の高さ " + v + "mm") : "行の高さ 自動"; }

  function readFit(){
    /* 編集モードでは画面フィットの縮小をかけない */
    if (STORAGE.getItem("seat-table-print-look") === "0") return false;
    return STORAGE.getItem(FITKEY) !== "0";
  }
  function applyFit(){
    if (window.__suspendPreviewFit) return;
    var wrap = q(".print-preview-wrap");
    var page = q(".print-preview-page");
    if (!wrap || !page) return;
    page.style.transform = "none";
    if (!readFit()){
      page.style.transform = "";
      page.style.transformOrigin = "";
      wrap.style.height = "";
      wrap.style.overflow = "";
      return;
    }
    var r = page.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var availW = wrap.clientWidth;
    var availH = Math.max(360, window.innerHeight - 140);
    var f = Math.min(availW / r.width, availH / r.height, 1);
    if (!isFinite(f) || f <= 0) f = 1;
    f = Math.max(0.2, f);
    page.style.transformOrigin = "top center";
    page.style.transform = "scale(" + f + ")";
    wrap.style.height = Math.ceil(r.height * f) + "px";
    wrap.style.overflow = "hidden";
  }

  var fitTimer = null;
  function scheduleFit(){
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(applyFit, 120);
  }

  function makeRow(anchor){
    var d = document.createElement("div");
    if (anchor) d.className = anchor.className;
    return d;
  }

  function inject(){
    var panel = q(".print-settings-panel");
    if (!panel || panel.querySelector("#printRowH")) return;
    var scaleInput = panel.querySelector("#printPageScale");
    var anchor = scaleInput ? scaleInput.parentElement : null;

    var row = makeRow(anchor);
    var lab = document.createElement("label");
    var input = document.createElement("input");
    input.type = "range";
    input.id = "printRowH";
    input.min = "0"; input.max = String(MAXMM); input.step = "1";
    var v = readRow();
    input.value = String(v);
    lab.textContent = rowText(v);
    input.addEventListener("input", function(){
      var nv = parseInt(input.value, 10);
      try { STORAGE.setItem(ROWKEY, String(nv)); } catch(e){}
      applyRow(nv);
      lab.textContent = rowText(nv);
      scheduleFit();
    });
    row.appendChild(lab);
    row.appendChild(input);
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(row, anchor.nextSibling);
    else panel.appendChild(row);

    var fitRow = makeRow(anchor);
    var fitLab = document.createElement("label");
    fitLab.textContent = "画面に合わせる";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "previewFit";
    cb.checked = readFit();
    cb.style.flex = "0 0 auto";
    cb.style.width = "18px";
    cb.style.height = "18px";
    cb.addEventListener("change", function(){
      try { STORAGE.setItem(FITKEY, cb.checked ? "1" : "0"); } catch(e){}
      applyFit();
    });
    fitRow.appendChild(fitLab);
    fitRow.appendChild(cb);
    if (row.parentElement) row.parentElement.insertBefore(fitRow, row.nextSibling);

    var scaleEl = panel.querySelector("#printPageScale");
    if (scaleEl) scaleEl.addEventListener("input", scheduleFit);
    var obs = new MutationObserver(scheduleFit);
    var wrap = q(".print-preview-wrap");
    if (wrap) obs.observe(wrap, { childList: true, subtree: true });
  }

  applyRow(readRow());
  function boot(){ inject(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else { try { boot(); } catch(e){} }
  setInterval(function(){ try { boot(); } catch(e){} }, 1500);
  window.addEventListener("resize", scheduleFit);
  document.addEventListener("click", scheduleFit, true);
  setTimeout(applyFit, 800);
})();

/* ==========================================================
   集団行: 集団名に含まれる時間を読み取り、空いている科目列に表示
   例) "HALLO土曜日-15:10~16:00" -> "15:10〜16:00"
   時間が書かれていない集団（中3社会-2026夏期集団 など）は何も出さない。
   科目が既に入っている行にも出さない。
   ========================================================== */
(function(){
  var RE = /(\d{1,2})\s*[:：]\s*(\d{2})\s*[~〜～\-–—]\s*(\d{1,2})\s*[:：]\s*(\d{2})/;
  function pad(n){ n = String(parseInt(n, 10)); return n.length < 2 ? ("0" + n) : n; }
  function timeOf(name){
    var m = RE.exec(String(name || ""));
    if (!m) return "";
    return pad(m[1]) + ":" + m[2] + "〜" + pad(m[3]) + ":" + m[4];
  }
  function nameOf(row){
    var i = row.querySelector(".group-name-cell input");
    if (i) return i.value;
    var d = row.querySelector(".group-name-cell");
    return d ? d.textContent : "";
  }
  function subjectCell(row){
    var cs = row.children;
    for (var i = 0; i < cs.length; i++){
      var cl = " " + cs[i].className + " ";
      if (cl.indexOf(" group-row ") >= 0
        && cl.indexOf("group-count") < 0
        && cl.indexOf("group-name") < 0
        && cl.indexOf("group-students") < 0
        && cl.indexOf("seat-num") < 0
        && cl.indexOf("teacher-col") < 0) return cs[i];
    }
    return null;
  }
  function clearInline(row){
    var s = row.querySelector(".group-time-inline");
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }
  function showInline(row, t){
    var nc = row.querySelector(".group-name-cell");
    if (!nc) return;
    var s = nc.querySelector(".group-time-inline");
    if (!s){
      s = document.createElement("span");
      s.className = "group-time-inline";
      nc.appendChild(s);
    }
    if (s.textContent !== t) s.textContent = t;
  }
  function clear(cell, input){
    var t = cell.querySelector(".group-time-auto");
    if (t && t.parentNode) t.parentNode.removeChild(t);
    if (input) input.style.display = "";
  }
  function decorate(){
    var rows = document.querySelectorAll(".group-row-wrap");
    for (var i = 0; i < rows.length; i++){
      var row = rows[i];
      var cell = subjectCell(row);
      if (!cell) continue;
      var input = cell.querySelector("input");
      if (cell.getAttribute("data-group-time-off") === "1"){ clear(cell, input); continue; }
      var t = "";
      if (typeof window.__seatGroupTime === "function") t = window.__seatGroupTime(row) || "";
      if (!t) t = timeOf(nameOf(row));
      var filled = input && input.value && input.value.trim() !== "";
      if (!t){ clear(cell, input); clearInline(row); continue; }
      if (filled){ clear(cell, input); showInline(row, t); continue; }
      clearInline(row);
      var tag = cell.querySelector(".group-time-auto");
      if (!tag){
        tag = document.createElement("span");
        tag.className = "group-time-auto";
        tag.title = "集団名から読み取った時間（クリックすると科目を入力できます）";
        tag.addEventListener("click", function(ev){
          var c = ev.currentTarget.parentNode;
          if (!c) return;
          c.setAttribute("data-group-time-off", "1");
          var ip = c.querySelector("input");
          if (ev.currentTarget.parentNode) ev.currentTarget.parentNode.removeChild(ev.currentTarget);
          if (ip){ ip.style.display = ""; ip.focus(); }
        });
        cell.appendChild(tag);
      }
      if (tag.textContent !== t) tag.textContent = t;
      if (input) input.style.display = "none";
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", decorate);
  else { try { decorate(); } catch(e){} }
  setInterval(function(){ try { decorate(); } catch(e){} }, 1000);
})();

/* ==========================================================
   eWeb取込payloadから集団の実施時間を拾って保存する
   payload例: {"date":"2026-07-27","komas":[{"id":47,"start":"13:50","end":"15:20"}],
              "groups":[{"koma_id":47,"start":"14:50","end":"15:50"}]}
   コマのstart/endでブロックを特定し、集団のstart/endを対応付ける。
   ========================================================== */
(function(){
  var KEY = "seat-table-group-times";
  function digits(s){ return String(s || "").replace(/[^0-9]/g, ""); }
  function load(){ try { return JSON.parse(STORAGE.getItem(KEY)) || {}; } catch(e){ return {}; } }
  function save(o){ try { STORAGE.setItem(KEY, JSON.stringify(o)); } catch(e){} }
  function absorb(text){
    var p = null;
    try { p = JSON.parse(text); } catch(e){ return false; }
    if (!p || !p.date || !p.komas || !p.groups) return false;
    if (!p.komas.length || !p.groups.length) return false;
    var byId = {}, i;
    for (i = 0; i < p.komas.length; i++) byId[p.komas[i].id] = p.komas[i];
    var map = {}, n = 0;
    for (i = 0; i < p.groups.length; i++){
      var g = p.groups[i];
      if (!g || !g.start || !g.end) continue;
      var k = byId[g.koma_id];
      if (!k || !k.start || !k.end) continue;
      map[digits(k.start) + digits(k.end)] = g.start + "〜" + g.end;
      n++;
    }
    if (!n) return false;
    var all = load();
    all[p.date] = map;
    save(all);
    return true;
  }
  function watch(){
    var tas = document.querySelectorAll("textarea"), i;
    for (i = 0; i < tas.length; i++){
      var ta = tas[i];
      if (ta.getAttribute("data-gt-watch") === "1") continue;
      ta.setAttribute("data-gt-watch", "1");
      ta.addEventListener("input", function(ev){ absorb(ev.target.value); });
      ta.addEventListener("paste", function(ev){
        var t = ev.target;
        setTimeout(function(){ absorb(t.value); }, 60);
      });
    }
  }
  function dateOf(row){
    var v = row.closest ? row.closest(".view") : null;
    var inp = v ? v.querySelector("input[type=\"date\"]") : null;
    if (!inp) inp = document.querySelector("#view-seat input[type=\"date\"]");
    return inp ? inp.value : "";
  }
  window.__seatGroupTime = function(row){
    var blk = row.closest ? row.closest(".lesson-block") : null;
    if (!blk) return "";
    var m = load()[dateOf(row)];
    if (!m) return "";
    return m[digits(blk.getAttribute("data-time"))] || "";
  };
  watch();
  setInterval(function(){ try { watch(); } catch(e){} }, 1200);
})();

/* ==========================================================
   印刷プレビューを実際の印刷結果に合わせる
   @media print のルールを読み取り、セレクタに .print-preview-page を
   付けた複製を screen 用に注入する。印刷CSSを変えれば自動で追従する。
   ========================================================== */
(function(){
  var ID = "preview-mirror-print";
  var SKIP = /^(@|html\b|body\b|main\b|\.topbar|\.tabs\b|\.tab-btn|\.save-indicator|\.brand|#view-|\.print-preview)/;
  function collect(rules, out){
    for (var i = 0; i < rules.length; i++){
      var r = rules[i];
      if (!r || !r.selectorText || !r.style) continue;
      var parts = r.selectorText.split(",");
      var keep = [];
      for (var j = 0; j < parts.length; j++){
        var sel = parts[j].trim();
        if (!sel || SKIP.test(sel)) continue;
        /* プレビューでの操作を殺すルールは複製しない */
        if (sel.indexOf("[data-empty-sel") >= 0) continue;
        if (sel.indexOf(".btn") >= 0) continue;
        /* 画像は印刷用の position:fixed を持ち込むと、プレビューで
           画面基準に固定されて位置・サイズが操作できなくなる */
        if (sel.indexOf(".print-image") >= 0) continue;
        keep.push(".print-preview-page " + sel);
      }
      if (!keep.length) continue;
      out.push(keep.join(", ") + "{" + r.style.cssText + "}");
    }
  }
  function build(){
    var old = document.getElementById(ID);
    var sheets = document.styleSheets, out = [], i, j;
    for (i = 0; i < sheets.length; i++){
      if (sheets[i].ownerNode && sheets[i].ownerNode.id === ID) continue;
      var rules = null;
      try { rules = sheets[i].cssRules; } catch(e){ continue; }
      if (!rules) continue;
      for (j = 0; j < rules.length; j++){
        var r = rules[j];
        if (!r || r.type !== 4) continue;
        var cond = String(r.conditionText || (r.media && r.media.mediaText) || "");
        if (cond.indexOf("print") < 0) continue;
        if (r.cssRules) collect(r.cssRules, out);
      }
    }
    if (!out.length) return;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var st = document.createElement("style");
    st.id = ID;
    st.setAttribute("media", "screen");
    st.textContent = out.join("\n");
    document.head.appendChild(st);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else { try { build(); } catch(e){} }
  setTimeout(build, 1500);
})();

/* ==========================================================
   未選択のセレクトに data-empty-sel を立てる
   印刷・プレビューでは「生徒を選択」「—」を空白にするため。
   画面編集時はCSS側で対象外なので今までどおり表示される。
   ========================================================== */
(function(){
  function mark(){
    var sels = document.querySelectorAll(".cell select");
    for (var i = 0; i < sels.length; i++){
      var s = sels[i];
      var empty = (s.value === "" || s.value === null);
      if (empty){
        if (s.getAttribute("data-empty-sel") !== "1") s.setAttribute("data-empty-sel", "1");
      } else if (s.hasAttribute("data-empty-sel")){
        s.removeAttribute("data-empty-sel");
      }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mark);
  else { try { mark(); } catch(e){} }
  document.addEventListener("change", function(){ setTimeout(mark, 0); }, true);
  setInterval(function(){ try { mark(); } catch(e){} }, 800);
})();

/* ==========================================================
   印刷プレビューの表示設定パネルを折りたためるようにする
   スライダーと画像欄で縦に長くなり、プレビューが画面外へ
   押し下げられるため。初期状態は閉じる。
   ========================================================== */
(function(){
  var KEY = "seat-table-print-panel-open";
  function isOpen(){ return STORAGE.getItem(KEY) === "1"; }
  function apply(panel, open){
    var kids = panel.children, i;
    for (i = 0; i < kids.length; i++){
      if (kids[i].getAttribute("data-panel-toggle") === "1") continue;
      kids[i].style.display = open ? "" : "none";
    }
  }
  function inject(){
    var panel = document.querySelector(".print-settings-panel");
    if (!panel || panel.querySelector("[data-panel-toggle]")) return;
    var bar = document.createElement("div");
    bar.setAttribute("data-panel-toggle", "1");
    bar.className = "print-panel-toggle";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    function label(){
      btn.textContent = isOpen()
        ? "表示設定を閉じる"
        : "表示設定を開く（文字サイズ・行の高さ・画像）";
    }
    btn.addEventListener("click", function(){
      var next = !isOpen();
      try { STORAGE.setItem(KEY, next ? "1" : "0"); } catch(e){}
      apply(panel, next);
      label();
    });
    label();
    bar.appendChild(btn);
    panel.insertBefore(bar, panel.firstChild);
    apply(panel, isOpen());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else { try { inject(); } catch(e){} }
  setInterval(function(){ try { inject(); } catch(e){} }, 1500);
})();

/* ==========================================================
   プレビューの表示モード切り替え
   ON  : 印刷と同じ見た目（8pt・9mm列。確認向け。行が12〜20pxで編集は困難）
   OFF : 画面用の大きさ（編集向け）
   ========================================================== */
(function(){
  var KEY = "seat-table-print-look";
  function isOn(){ return STORAGE.getItem(KEY) !== "0"; }
  function apply(){
    var st = document.getElementById("preview-mirror-print");
    if (st) st.disabled = !isOn();
    document.documentElement.setAttribute("data-print-look", isOn() ? "1" : "0");
  }
  function inject(){
    var bar = document.querySelector(".print-panel-toggle");
    if (!bar || bar.querySelector("#printLookToggle")) return;
    bar.style.display = "flex";
    bar.style.alignItems = "center";
    bar.style.flexWrap = "wrap";
    bar.style.gap = "12px";
    var lab = document.createElement("label");
    lab.style.fontSize = "13px";
    lab.style.display = "inline-flex";
    lab.style.alignItems = "center";
    lab.style.gap = "6px";
    lab.style.cursor = "pointer";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "printLookToggle";
    cb.checked = isOn();
    cb.addEventListener("change", function(){
      try { STORAGE.setItem(KEY, cb.checked ? "1" : "0"); } catch(e){}
      apply();
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode("印刷と同じ見た目で表示（外すと編集しやすい大きさになります）"));
    bar.appendChild(lab);
    apply();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else { try { inject(); } catch(e){} }
  setInterval(function(){ try { inject(); apply(); } catch(e){} }, 1500);
})();

/* ==========================================================
   画像の大きさ・不透明度スライダーを即時プレビューに反映する
   値は保存されるが再描画が走らないため、動かしても見た目が
   変わらない。スライダー操作中に直接インラインstyleへ当てる。
   ========================================================== */
(function(){
  function pairs(){
    var panel = document.querySelector(".print-settings-panel");
    if (!panel) return [];
    var all = panel.querySelectorAll("input[type=range]"), noId = [], i;
    for (i = 0; i < all.length; i++){ if (!all[i].id) noId.push(all[i]); }
    var out = [];
    for (i = 0; i + 1 < noId.length; i += 2) out.push([noId[i], noId[i + 1]]);
    return out;
  }
  function images(){
    return document.querySelectorAll(".print-preview-page img.print-image");
  }
  function live(){
    var ps = pairs(), im = images(), i;
    for (i = 0; i < ps.length && i < im.length; i++){
      var w = parseFloat(ps[i][0].value);
      var o = parseFloat(ps[i][1].value);
      if (isFinite(w)) im[i].style.width = w + "%";
      if (isFinite(o)) im[i].style.opacity = String(o / 100);
    }
  }
  function bind(){
    var ps = pairs(), i, j;
    for (i = 0; i < ps.length; i++){
      for (j = 0; j < 2; j++){
        var el = ps[i][j];
        if (!el || el.getAttribute("data-img-live") === "1") continue;
        el.setAttribute("data-img-live", "1");
        el.addEventListener("input", live);
        el.addEventListener("change", live);
      }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else { try { bind(); } catch(e){} }
  setInterval(function(){ try { bind(); } catch(e){} }, 1000);
})();

/* ==========================================================
   生徒名簿: 生年月日をまとめて貼り付け
   1行1人。「氏名 生年月日」または生年月日のみ（名簿の並び順）。
   氏名は空白（半角・全角）を無視して照合する。
   ========================================================== */
(function(){
  var ID = "birthdate-bulk";
  var KEY = "seat-table-v1";
  function norm(s){ return String(s || "").replace(/[\s\u3000,\uFF0C\u3001;\uFF1B\t]+/g, ""); }
  function pad(n){ return (n < 10 ? "0" : "") + n; }
  function toISO(y, m, d){
    y = parseInt(y, 10); m = parseInt(m, 10); d = parseInt(d, 10);
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return "";
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return "";
    return y + "-" + pad(m) + "-" + pad(d);
  }
  function parseLine(ln){
    var m = ln.match(/(\d{4})\s*[\/\-\.年]\s*(\d{1,2})\s*[\/\-\.月]\s*(\d{1,2})\s*[日]?/);
    if (!m) return { name: norm(ln), iso: "" };
    return { name: norm(ln.replace(m[0], " ")), iso: toISO(m[1], m[2], m[3]) };
  }
  function entries(text){
    var out = [], lines = String(text || "").split(/\r?\n/), i;
    for (i = 0; i < lines.length; i++){ if (norm(lines[i])) out.push(parseLine(lines[i])); }
    return out;
  }
  function build(text){
    var s = null;
    try { s = JSON.parse(STORAGE.getItem(KEY)); } catch(e){ return null; }
    if (!s || !s.students) return null;
    var idx = {}, i;
    for (i = 0; i < s.students.length; i++) idx[norm(s.students[i].name)] = i;
    var es = entries(text), plan = [], unmatched = [], invalid = 0, order = 0;
    for (i = 0; i < es.length; i++){
      var e = es[i];
      if (!e.iso){ invalid++; continue; }
      if (e.name){
        if (idx[e.name] === undefined){ unmatched.push(e.name); continue; }
        plan.push({ i: idx[e.name], iso: e.iso });
      } else {
        if (order < s.students.length) plan.push({ i: order, iso: e.iso });
        order++;
      }
    }
    return { state: s, plan: plan, unmatched: unmatched, invalid: invalid, total: es.length };
  }
  function inject(){
    var view = document.querySelector("#view-students");
    if (!view || document.getElementById(ID)) return;
    var box = document.createElement("div");
    box.id = ID; box.className = "panel"; box.style.marginBottom = "12px";
    var h = document.createElement("h3");
    h.textContent = "生年月日をまとめて貼り付け";
    var p = document.createElement("p");
    p.style.fontSize = "13px";
    p.textContent = "1行に1人。「氏名 生年月日」の形か、生年月日だけ（名簿の並び順に対応）。氏名は空白の有無を無視して照合します。日付は 2011/5/3・2011-5-3・2011年5月3日 のいずれでも可。";
    var ta = document.createElement("textarea");
    ta.rows = 6; ta.style.width = "100%";
    ta.placeholder = "山田 太郎\t2012/04/02\n佐藤 花子 2013-5-15";
    var row = document.createElement("div");
    row.style.display = "flex"; row.style.gap = "8px"; row.style.alignItems = "center";
    row.style.marginTop = "8px"; row.style.flexWrap = "wrap";
    var checkBtn = document.createElement("button");
    checkBtn.type = "button"; checkBtn.className = "btn"; checkBtn.textContent = "照合する";
    var applyBtn = document.createElement("button");
    applyBtn.type = "button"; applyBtn.className = "btn"; applyBtn.textContent = "反映して再読み込み";
    applyBtn.disabled = true;
    var msg = document.createElement("div");
    msg.style.fontSize = "13px"; msg.style.marginTop = "8px"; msg.style.whiteSpace = "pre-wrap";
    checkBtn.addEventListener("click", function(){
      var r = build(ta.value);
      if (!r){ msg.textContent = "名簿データを読み込めませんでした。"; applyBtn.disabled = true; return; }
      var out = [];
      out.push("照合できた: " + r.plan.length + "件 / 入力 " + r.total + "行");
      if (r.unmatched.length) out.push("名簿に見つからない氏名: " + r.unmatched.join("、"));
      if (r.invalid) out.push("日付が読めない行: " + r.invalid + "件");
      out.push("「反映して再読み込み」で保存し、ページを読み直します。");
      msg.textContent = out.join("\n");
      applyBtn.disabled = (r.plan.length === 0);
    });
    applyBtn.addEventListener("click", function(){
      var r = build(ta.value);
      if (!r || !r.plan.length) return;
      var i;
      for (i = 0; i < r.plan.length; i++) r.state.students[r.plan[i].i].birthdate = r.plan[i].iso;
      try { STORAGE.setItem(KEY, JSON.stringify(r.state)); } catch(e){ msg.textContent = "保存に失敗しました。"; return; }
      location.reload();
    });
    row.appendChild(checkBtn); row.appendChild(applyBtn);
    box.appendChild(h); box.appendChild(p); box.appendChild(ta);
    box.appendChild(row); box.appendChild(msg);
    view.insertBefore(box, view.firstChild);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else { try { inject(); } catch(e){} }
  setInterval(function(){ try { inject(); } catch(e){} }, 1500);
})();

/* ==========================================================
   生徒名簿: 生年月日順の並べ替えと、学年の自動計算
   学年は4月1日時点の年齢基準。学年gは
   (年度-6-g)年4月2日 〜 (年度-5-g)年4月1日 生まれ。
   例) 2026年度の中3(g=9) = 2011/4/2〜2012/4/1
   ========================================================== */
(function(){
  var KEY = "seat-table-v1";
  function state(){ try { return JSON.parse(STORAGE.getItem(KEY)); } catch(e){ return null; } }
  function schoolYear(d){ return (d.getMonth() + 1 >= 4) ? d.getFullYear() : d.getFullYear() - 1; }
  function gradeOf(iso, today){
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(iso || ""));
    if (!m) return "";
    var b = new Date(+m[1], +m[2] - 1, +m[3]);
    var Y = schoolYear(today), g;
    for (g = 1; g <= 12; g++){
      var s = new Date(Y - 6 - g, 3, 2);
      var e = new Date(Y - 5 - g, 3, 1);
      if (b >= s && b <= e) break;
    }
    if (g > 12){
      /* 小1の範囲より後に生まれていれば未就学、それより前なら高3を終えている */
      if (b > new Date(Y - 6, 3, 1)) return "未就学";
      return "既卒";
    }
    if (g <= 6) return "小" + g;
    if (g <= 9) return "中" + (g - 6);
    return "高" + (g - 9);
  }
  window.__gradeFromBirthdate = gradeOf;
  function mkBtn(text, fn){
    var b = document.createElement("button");
    b.type = "button"; b.className = "btn"; b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  }
  function fillGrades(){
    var s = state();
    if (!s || !s.students) return;
    var today = new Date(), upd = 0, noBd = 0, outOfRange = 0, same = 0, i;
    for (i = 0; i < s.students.length; i++){
      var st = s.students[i];
      if (!st.birthdate){ noBd++; continue; }
      var g = gradeOf(st.birthdate, today);
      if (!g){ outOfRange++; continue; }
      if (st.grade === g){ same++; continue; }
      st.grade = g; upd++;
    }
    var msg = "学年を更新: " + upd + "件\n変更なし: " + same + "件\n生年月日なし: " + noBd + "件\n小1〜高3の範囲外: " + outOfRange + "件\n\n保存してページを再読み込みします。";
    if (!window.confirm(msg)) return;
    try { STORAGE.setItem(KEY, JSON.stringify(s)); } catch(e){ return; }
    location.reload();
  }
  function gradeRank(g){
    var m = /^(小|中|高)(\d)$/.exec(String(g || ""));
    if (!m) return 99;
    var base = (m[1] === "小") ? 0 : ((m[1] === "中") ? 6 : 9);
    return base + (+m[2]);
  }
  function valOf(st, key){
    if (key === "name") return st.name || "";
    if (key === "grade") return st.grade || "";
    return st.birthdate || "";
  }
  function cmpKey(a, b, key){
    if (key === "name") return String(a.name||"").localeCompare(String(b.name||""), "ja");
    if (key === "grade") return gradeRank(a.grade) - gradeRank(b.grade);
    var x = a.birthdate || "", y = b.birthdate || "";
    return x < y ? -1 : (x > y ? 1 : 0);
  }
  function doSort(key, dir){
    var s = state();
    if (!s || !s.students) return;
    var label = (key === "name") ? "氏名" : ((key === "grade") ? "学年" : "生年月日");
    var dirLabel = (dir === "desc") ? "降順" : "昇順";
    var filled = 0, i;
    for (i = 0; i < s.students.length; i++) if (valOf(s.students[i], key)) filled++;
    var msg = label + "の" + dirLabel + "で並べ替えます。\n値あり: " + filled + "件\n未入力: " + (s.students.length - filled) + "件（昇降どちらでも末尾）\n\n保存して表示を更新します。";
    if (!window.confirm(msg)) return;
    s.students.sort(function(a, b){
      var ae = !valOf(a, key), be = !valOf(b, key);
      if (ae && be) return 0;
      if (ae) return 1;
      if (be) return -1;
      var r = cmpKey(a, b, key);
      return (dir === "desc") ? -r : r;
    });
    try { STORAGE.setItem(KEY, JSON.stringify(s)); } catch(e){ return; }
    location.reload();
  }
  function sortByBirthdate(){
    var s = state();
    if (!s || !s.students) return;
    var withBd = 0, i;
    for (i = 0; i < s.students.length; i++) if (s.students[i].birthdate) withBd++;
    var msg = "生年月日の古い順に並べ替えます。\n生年月日あり: " + withBd + "件\n生年月日なし: " + (s.students.length - withBd) + "件（末尾へ）\n\n保存してページを再読み込みします。";
    if (!window.confirm(msg)) return;
    s.students.sort(function(a, b){
      var x = a.birthdate || "", y = b.birthdate || "";
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? -1 : (x > y ? 1 : 0);
    });
    try { STORAGE.setItem(KEY, JSON.stringify(s)); } catch(e){ return; }
    location.reload();
  }
  function inject(){
    var box = document.getElementById("birthdate-bulk");
    if (!box || box.querySelector("[data-bd-extra]")) return;
    var row = document.createElement("div");
    row.setAttribute("data-bd-extra", "1");
    row.style.display = "flex"; row.style.gap = "8px";
    row.style.flexWrap = "wrap"; row.style.marginTop = "10px";
    row.appendChild(mkBtn("生年月日から学年を入れる", fillGrades));
    var sortLab = document.createElement("span");
    sortLab.textContent = "並べ替え:";
    sortLab.style.fontSize = "13px";
    var keySel = document.createElement("select");
    [["birthdate", "生年月日"], ["name", "氏名"], ["grade", "学年"]].forEach(function(o){
      var op = document.createElement("option");
      op.value = o[0]; op.textContent = o[1]; keySel.appendChild(op);
    });
    var dirSel = document.createElement("select");
    [["asc", "昇順"], ["desc", "降順"]].forEach(function(o){
      var op = document.createElement("option");
      op.value = o[0]; op.textContent = o[1]; dirSel.appendChild(op);
    });
    row.appendChild(sortLab);
    row.appendChild(keySel);
    row.appendChild(dirSel);
    row.appendChild(mkBtn("並べ替える", function(){ doSort(keySel.value, dirSel.value); }));
    box.appendChild(row);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else { try { inject(); } catch(e){} }
  setInterval(function(){ try { inject(); } catch(e){} }, 1500);
})();

/* ==========================================================
   再読み込み後に表示中のタブを維持する
   並べ替えや学年一括入力の後に座席表へ戻ってしまうのを防ぐ。
   sessionStorage なので次回の起動時は通常どおり。
   ========================================================== */
(function(){
  var KEY = "seat-table-active-tab";
  function save(){
    /* タブ名は件数バッジを含み変動するため、位置で覚える */
    var btns = document.querySelectorAll(".tab-btn"), i;
    for (i = 0; i < btns.length; i++){
      if (/(^|\s)active(\s|$)/.test(btns[i].className)){
        try { SESSION_STORAGE.setItem(KEY, String(i)); } catch(e){}
        return;
      }
    }
  }
  function restore(){
    var want = null;
    try { want = SESSION_STORAGE.getItem(KEY); } catch(e){ return; }
    var i = parseInt(want, 10);
    if (!isFinite(i) || i < 0) return;
    var btns = document.querySelectorAll(".tab-btn");
    if (i >= btns.length) return;
    if (!/(^|\s)active(\s|$)/.test(btns[i].className)) btns[i].click();
  }
  document.addEventListener("click", function(ev){
    var t = ev.target;
    while (t && t !== document){
      if (t.classList && t.classList.contains("tab-btn")){ setTimeout(save, 60); return; }
      t = t.parentNode;
    }
  }, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ setTimeout(restore, 300); });
  else setTimeout(restore, 300);
})();

/* ==========================================================
   用紙の向き（A3横 / A3縦）
   枠数が多い日は横だと2枚になるため、縦(404mm)を選べるようにする。
   @page は属性で切り替えられないので style を差し替える。
   ========================================================== */
(function(){
  var KEY = "seat-table-paper";
  var SID = "paper-orientation-style";
  function get(){ return STORAGE.getItem(KEY) === "portrait" ? "portrait" : "landscape"; }
  function apply(){
    var v = get();
    document.documentElement.setAttribute("data-paper", v);
    var st = document.getElementById(SID);
    if (!st){
      st = document.createElement("style");
      st.id = SID;
      document.head.appendChild(st);
    }
    st.textContent = "@page{ size: A3 " + v + "; margin: 10mm; }";
  }
  function inject(){
    var bar = document.querySelector(".print-panel-toggle");
    if (!bar || bar.querySelector("#paperOrientation")) return;
    var lab = document.createElement("label");
    lab.style.fontSize = "13px";
    lab.style.display = "inline-flex";
    lab.style.alignItems = "center";
    lab.style.gap = "6px";
    lab.appendChild(document.createTextNode("用紙:"));
    var sel = document.createElement("select");
    sel.id = "paperOrientation";
    [["landscape", "A3 横（2列）"], ["portrait", "A3 縦（枠が多い日向け）"]].forEach(function(o){
      var op = document.createElement("option");
      op.value = o[0]; op.textContent = o[1];
      sel.appendChild(op);
    });
    sel.value = get();
    sel.addEventListener("change", function(){
      try { STORAGE.setItem(KEY, sel.value); } catch(e){}
      apply();
    });
    lab.appendChild(sel);
    bar.appendChild(lab);
  }
  apply();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else { try { inject(); } catch(e){} }
  setInterval(function(){ try { inject(); apply(); } catch(e){} }, 1500);
})();

/* ==========================================================
   「1枚に収める」
   縦に収まらない主因は行の高さと文字サイズなので、
   行を詰める → 文字を段階的に小さくする → 最後に倍率、の順で試す。
   倍率(transform)は文字がぼやけるため最後の手段にする。
   ========================================================== */
(function(){
  var SCALE_KEY = "seat-table-print-scale";
  var ROW_KEY = "seat-table-print-row-h";
  var UNDO_KEY = "seat-table-fit-undo";
  var MIN = 0.5;
  var busy = false;
  function root(){ return document.documentElement; }
  function page(){ return document.querySelector(".print-preview-page"); }
  function content(){ var p = page(); return p ? p.querySelector(".blocks") : null; }
  function setScale(v){ root().style.setProperty("--print-page-scale", String(v)); }
  function setRow(mm){ root().style.setProperty("--print-row-h", mm > 0 ? (mm + "mm") : "0px"); }
  function ratio(){
    var p = page(), c = content();
    if (!p || !c) return 99;
    var ph = p.getBoundingClientRect().height;
    if (!ph) return 99;
    return c.getBoundingClientRect().height / ph;
  }
  function curRow(){
    var v = parseFloat(STORAGE.getItem(ROW_KEY));
    return isFinite(v) && v >= 0 ? v : 0;
  }
  function readState(){
    var s = JSON.parse(STORAGE.getItem("seat-table-v1") || "null");
    var subj = s && s.printSettings ? s.printSettings.subjectSize : 15;
    var stu = s && s.printSettings ? s.printSettings.studentSize : 10.5;
    var scale = parseFloat(STORAGE.getItem(SCALE_KEY));
    if (!isFinite(scale)) scale = 1;
    return { row: curRow(), subj: subj, stu: stu, scale: scale };
  }
  function writeState(st){
    try {
      STORAGE.setItem(ROW_KEY, String(st.row));
      STORAGE.setItem(SCALE_KEY, String(st.scale));
      var s = JSON.parse(STORAGE.getItem("seat-table-v1"));
      if (s && s.printSettings){
        s.printSettings.subjectSize = st.subj;
        s.printSettings.studentSize = st.stu;
        STORAGE.setItem("seat-table-v1", JSON.stringify(s));
      }
    } catch(e){}
  }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  async function fitsAt(s){ setScale(s); await sleep(60); return ratio() <= 1.002; }
  async function search(rowMm){
    setRow(rowMm);
    await sleep(60);
    if (await fitsAt(1)) return 1;
    if (!(await fitsAt(MIN))) return null;
    var lo = MIN, hi = 1, i, mid;
    for (i = 0; i < 6; i++){
      mid = (lo + hi) / 2;
      if (await fitsAt(mid)) lo = mid; else hi = mid;
    }
    return Math.floor(lo * 20) / 20;
  }
  async function run(btn){
    if (busy) return;
    if (!page()){ window.alert("プレビューを表示してから実行してください。"); return; }
    busy = true;
    window.__suspendPreviewFit = true;
    var before = readState();
    var oldScale = before.scale, oldRow = before.row;
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = "計算中…";
    var rows = [oldRow, 12, 8, 4, 0], tried = {}, found = null, usedRow = oldRow, i, r;
    for (i = 0; i < rows.length; i++){
      r = rows[i];
      if (r > oldRow || tried[r]) continue;
      tried[r] = 1;
      found = await search(r);
      if (found){ usedRow = r; break; }
    }
    btn.disabled = false; btn.textContent = label;
    busy = false;
    window.__suspendPreviewFit = false;
    window.dispatchEvent(new Event("resize"));
    if (!found){
      setScale(oldScale); setRow(oldRow);
      window.alert("50%まで縮めても1枚に収まりませんでした。\n用紙をA3縦にするか、授業枠を分けて印刷してください。");
      return;
    }
    var pct = Math.round(found * 100);
    var msg = "全体の大きさ " + pct + "%";
    if (usedRow !== oldRow) msg += "、行の高さ " + usedRow + "mm";
    msg += " で1枚に収まります。\nこの設定を保存しますか？";
    if (!window.confirm(msg)){
      setScale(oldScale); setRow(oldRow);
      return;
    }
    /* 保存する前の状態を「元に戻す」用に控えておく */
    try { STORAGE.setItem(UNDO_KEY, JSON.stringify(before)); } catch(e){}
    var sc = document.getElementById("printPageScale");
    if (sc){ sc.value = String(pct); sc.dispatchEvent(new Event("input", { bubbles: true })); }
    var rw = document.getElementById("printRowH");
    if (rw){ rw.value = String(usedRow); rw.dispatchEvent(new Event("input", { bubbles: true })); }
    setScale(found); setRow(usedRow);
    writeState({ row: usedRow, subj: before.subj, stu: before.stu, scale: found });
    updateUndoButton();
  }
  function undoBtn(){ return document.getElementById("undoFitOnePage"); }
  function updateUndoButton(){
    var b = undoBtn();
    if (!b) return;
    b.style.display = STORAGE.getItem(UNDO_KEY) ? "" : "none";
  }
  function doUndo(){
    var raw = STORAGE.getItem(UNDO_KEY);
    if (!raw) return;
    var st = null;
    try { st = JSON.parse(raw); } catch(e){}
    if (!st) return;
    setScale(st.scale); setRow(st.row);
    writeState(st);
    var sc = document.getElementById("printPageScale");
    if (sc){ sc.value = String(Math.round(st.scale * 100)); sc.dispatchEvent(new Event("input", { bubbles: true })); }
    var rw = document.getElementById("printRowH");
    if (rw){ rw.value = String(st.row); rw.dispatchEvent(new Event("input", { bubbles: true })); }
    try { STORAGE.removeItem(UNDO_KEY); } catch(e){}
    updateUndoButton();
    window.dispatchEvent(new Event("resize"));
  }
  function inject(){
    var bar = document.querySelector(".print-panel-toggle");
    if (!bar) return;
    if (!bar.querySelector("#fitOnePage")){
      var b = document.createElement("button");
      b.type = "button"; b.className = "btn"; b.id = "fitOnePage";
      b.textContent = "1枚に収める";
      b.addEventListener("click", function(){ run(b); });
      bar.appendChild(b);
    }
    if (!bar.querySelector("#undoFitOnePage")){
      var u = document.createElement("button");
      u.type = "button"; u.className = "btn"; u.id = "undoFitOnePage";
      u.textContent = "元に戻す";
      u.addEventListener("click", doUndo);
      bar.appendChild(u);
      updateUndoButton();
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else { try { inject(); } catch(e){} }
  setInterval(function(){ try { inject(); } catch(e){} }, 1500);
})();

/* ==========================================================
   印刷直前に紙面へ収める。固定mm幅や授業枠の高さで
   コピー機の印字領域からはみ出すのを防ぐ。
   ========================================================== */
(function(){
  var applied = [];
  /* コピー機は @page 余白より内側しか印字できない。実寸ぴったりだと必ずはみ出す。 */
  var SAFETY = 0.86;
  function userScale(){
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--print-page-scale"));
    return (isFinite(v) && v > 0.2) ? v : 1;
  }
  function paperPx(){
    var cs = getComputedStyle(document.documentElement);
    var mm = function(name){
      var n = parseFloat(cs.getPropertyValue(name));
      return isFinite(n) && n > 0 ? n : 0;
    };
    var px = 96 / 25.4;
    return {
      w: (mm("--paper-w") || 404) * px,
      h: (mm("--paper-h") || 281) * px
    };
  }
  function boxes(){
    if (document.body.classList.contains("multi-day-print")){
      return Array.prototype.slice.call(document.querySelectorAll(".multi-print-page"));
    }
    var preview = document.querySelector("#view-print:not([hidden]) .print-preview-page");
    if (preview) return [preview];
    var seat = document.querySelector("#view-seat:not([hidden])");
    return seat ? [seat] : [];
  }
  function fitBox(box){
    var blocks = box.querySelector(".blocks");
    if (!blocks) return;
    blocks.style.transform = "none";
    blocks.style.width = "100%";
    var paper = paperPx();
    var w = paper.w;
    var h = paper.h;
    var head = box.querySelector(".page-head");
    var headH = 0;
    if (head){
      var pageScale = 1;
      var tr = getComputedStyle(box).transform;
      if (tr && tr !== "none"){
        var m = tr.match(/matrix\(([^,]+)/);
        if (m) pageScale = Math.abs(parseFloat(m[1])) || 1;
      }
      headH = head.getBoundingClientRect().height / pageScale;
    }
    var availW = Math.max(1, w);
    var availH = Math.max(1, h - headH);
    var need = Math.min(1, availW / Math.max(1, blocks.scrollWidth), availH / Math.max(1, blocks.scrollHeight));
    var s = Math.min(userScale(), need) * SAFETY;
    if (s < 0.35) s = 0.35;
    if (s > 1) s = 1;
    blocks.style.transformOrigin = "top left";
    blocks.style.transform = "scale(" + s + ")";
    blocks.style.width = (100 / s) + "%";
    applied.push(blocks);
    return blocks;
  }
  function fit(){
    window.__suspendPreviewFit = true;
    applied = [];
    boxes().forEach(fitBox);
  }
  function syncPreview(){
    var preview = document.querySelector("#view-print:not([hidden]) .print-preview-page");
    if (!preview) return;
    applied = applied.filter(function(el){ return el && el.isConnected && !preview.contains(el); });
    fitBox(preview);
    window.__suspendPreviewFit = false;
    window.dispatchEvent(new Event("resize"));
  }
  function clear(){
    applied.forEach(function(el){
      if (!el || !el.isConnected) return;
      if (el.closest && el.closest("#view-print")) return;
      el.style.transform = "";
      el.style.width = "";
    });
    applied = applied.filter(function(el){ return el && el.isConnected && el.style.transform; });
    window.__suspendPreviewFit = false;
    syncPreview();
  }
  window.addEventListener("beforeprint", fit);
  window.addEventListener("afterprint", clear);
  window.__fitPrintToPaper = fit;
  window.__syncPrintPreview = syncPreview;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ setTimeout(syncPreview, 200); });
  else setTimeout(syncPreview, 200);
  setInterval(function(){ try { syncPreview(); } catch(e){} }, 1500);
})();

/* ==========================================================
   eWeb取込: 振替の自動判定
   ブックマークレットが各予定の全項目を走査し、値に「振替」を含む
   項目を flags として持ってくる。ここではそれを見て status を
   substitute（振替）にする。項目名を事前に知る必要がない。
   ========================================================== */
(function(){
  var KEY = "seat-table-substitutes";
  function norm(s){ return String(s || "").replace(/[\s\u3000]+/g, ""); }
  function digits(s){ return String(s || "").replace(/[^0-9]/g, ""); }
  function load(){ try { return JSON.parse(STORAGE.getItem(KEY)) || {}; } catch(e){ return {}; } }
  function absorb(text){
    var p = null;
    try { p = JSON.parse(text); } catch(e){ return false; }
    if (!p || !p.date || !p.items) return false;
    var byId = {}, i;
    if (p.komas){ for (i = 0; i < p.komas.length; i++) byId[p.komas[i].id] = p.komas[i]; }
    /* 名前だけで照合すると、同じ生徒が同日に複数コマ入っている場合や
       同姓同名の生徒がいる場合に、無関係なコマまで振替扱いになる。
       コマの時間も合わせたキーにして、該当コマだけに限定する。 */
    var map = {}, n = 0;
    for (i = 0; i < p.items.length; i++){
      var it = p.items[i];
      if (!it) continue;
      var raw = it.raw || {};
      var st = raw.state;
      var kind = "";
      if (st === 3 || raw.reschedule_class_date) kind = "transfer";
      else if (it.flags && it.flags.length) kind = "transfer";
      if (!kind) continue;
      var k = byId[it.koma_id];
      var timeKey = k ? (digits(k.start) + digits(k.end)) : "";
      map[norm(it.student_name) + "@" + timeKey] = kind;
      n++;
    }
    var all = load();
    all[p.date] = map;
    try { STORAGE.setItem(KEY, JSON.stringify(all)); } catch(e){}
    return n > 0;
  }
  function watch(){
    var tas = document.querySelectorAll("textarea"), i;
    for (i = 0; i < tas.length; i++){
      var ta = tas[i];
      if (ta.getAttribute("data-sub-watch") === "1") continue;
      ta.setAttribute("data-sub-watch", "1");
      ta.addEventListener("input", function(ev){ absorb(ev.target.value); });
      ta.addEventListener("paste", function(ev){
        var t = ev.target;
        setTimeout(function(){ absorb(t.value); }, 60);
      });
    }
  }
  function dateOf(el){
    var v = el.closest ? el.closest(".view") : null;
    var inp = v ? v.querySelector("input[type=\"date\"]") : null;
    if (!inp) inp = document.querySelector("#view-seat input[type=\"date\"]");
    return inp ? inp.value : "";
  }
  function mark(){
    var cells = document.querySelectorAll(".student-cell"), i;
    for (i = 0; i < cells.length; i++){
      var cell = cells[i];
      var sel = cell.querySelector("select");
      if (!sel || !sel.value) continue;
      var blk = cell.closest ? cell.closest(".lesson-block") : null;
      var timeKey = blk ? digits(blk.getAttribute("data-time")) : "";
      var m = load()[dateOf(cell)];
      if (!m) continue;
      var name = norm(sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : "");
      var kind = m[name + "@" + timeKey];
      if (!kind) continue;
      /* cell.parentElement は行全体で左右の生徒のボタンが並ぶため、
         そこから探すと隣の生徒のボタンを押してしまう。cell自身の範囲に限定する。 */
      var btns = cell.querySelectorAll("button");
      var j;
      var want = (kind === "absent") ? "\u6b20\u5e2d" : "\u632f\u66ff";
      var already = false;
      for (j = 0; j < btns.length; j++){
        if (btns[j].textContent.trim() === want && btns[j].classList.contains("active")){ already = true; break; }
      }
      if (already){ cell.setAttribute("data-sub-done", "1"); continue; }
      cell.setAttribute("data-sub-done", "1");
      for (j = 0; j < btns.length; j++){
        if (btns[j].textContent.trim() === want){ btns[j].click(); break; }
      }
    }
  }
  watch();
  setInterval(function(){ try { watch(); mark(); } catch(e){} }, 1200);
})();

/* ==========================================================
   1対1（eWebで斜線）の反映
   eWebは科目名の括弧で区別している。
   1対1: 通<国> のように山括弧 / 1対2: 通(数) のように丸括弧。
   取込payloadから山括弧の生徒を拾い、同じ席の相手側を斜線にする。
   ========================================================== */
(function(){
  var KEY = "seat-table-solo";
  function norm(s){ return String(s || "").replace(/[\s\u3000]+/g, ""); }
  function load(){ try { return JSON.parse(STORAGE.getItem(KEY)) || {}; } catch(e){ return {}; } }
  function isSolo(subj){ return /[<\uFF1C][^>\uFF1E]*[>\uFF1E]/.test(String(subj || "")); }
  function stripBrackets(subj){ return String(subj || "").replace(/[<\uFF1C][^>\uFF1E]*[>\uFF1E]/g, "").trim(); }
  function comboKey(name, subj){ return norm(name) + "\u2016" + norm(stripBrackets(subj)); }
  function absorb(text){
    var p = null;
    try { p = JSON.parse(text); } catch(e){ return false; }
    if(!p || !p.date) return false;
    if(typeof soloMapFromEwebPayload !== "function" || typeof saveEwebSoloMap !== "function") return false;
    var map = soloMapFromEwebPayload(p);
    saveEwebSoloMap(p.date, map);
    return Object.keys(map).length > 0;
  }
  function watch(){
    var tas = document.querySelectorAll("textarea"), i;
    for (i = 0; i < tas.length; i++){
      var ta = tas[i];
      if (ta.getAttribute("data-solo-watch") === "1") continue;
      ta.setAttribute("data-solo-watch", "1");
      ta.addEventListener("input", function(ev){ absorb(ev.target.value); });
      ta.addEventListener("paste", function(ev){
        var t = ev.target;
        setTimeout(function(){ absorb(t.value); }, 60);
      });
    }
  }
  function dateOf(el){
    var tagged = el.closest ? el.closest("[data-solo-date]") : null;
    if (tagged){
      var taggedDate = tagged.getAttribute("data-solo-date");
      if (taggedDate) return taggedDate;
    }
    var v = el.closest ? el.closest(".view") : null;
    var inp = v ? v.querySelector("input[type=\"date\"]") : null;
    if (!inp) inp = document.querySelector("#view-seat input[type=\"date\"]");
    return inp ? inp.value : "";
  }
  function nameOf(cell){
    var s = cell.querySelector("select");
    if (!s || !s.value) return "";
    var o = s.options[s.selectedIndex];
    return o ? norm(o.text) : "";
  }
  function subjectOf(cell){
    var inp = cell.querySelector(".js-subject");
    return inp ? inp.value : "";
  }
  function slashSvg(){
    return (typeof soloSlashMarkHtml === "function") ? soloSlashMarkHtml() : "";
  }
  function setBlocked(cells, on){
    cells.forEach(function(c){
      if (!c) return;
      c.classList.toggle("solo-blocked", on);
      var mark = c.querySelector(".solo-slash-mark");
      if (on){
        if (!mark) c.insertAdjacentHTML("beforeend", slashSvg());
      } else if (mark && mark.parentNode){
        mark.parentNode.removeChild(mark);
      }
    });
  }
  /* 斜線は各セル内のSVG実要素。判定は「生徒名＋科目」の組み合わせ。
     同じ生徒でも科目によって1対1だったり1対2だったりするため。 */
  function paint(){
    var views = document.querySelectorAll(".view, .print-preview-page"), vi, rows = [];
    for (vi = 0; vi < views.length; vi++){
      var view = views[vi];
      if (view.classList.contains("view") && view.hidden) continue;
      var found = view.querySelectorAll(".seat-row-wrap");
      for (var fi = 0; fi < found.length; fi++) rows.push(found[fi]);
    }
    var i;
    for (i = 0; i < rows.length; i++){
      var row = rows[i];
      var kids = row.children;
      if (kids.length < 8) continue;
      var map = load()[dateOf(row)] || {};
      var leftName = nameOf(kids[4]), rightName = nameOf(kids[7]);
      var leftKey = comboKey(leftName, subjectOf(kids[2]));
      var rightKey = comboKey(rightName, subjectOf(kids[5]));
      var leftSolo = !!(leftName && map[leftKey]);
      var rightSolo = !!(rightName && map[rightKey]);
      var onRight = leftSolo && !rightName;
      var onLeft = rightSolo && !leftName;
      setBlocked([kids[5], kids[6], kids[7]], onRight);
      setBlocked([kids[2], kids[3], kids[4]], onLeft);
    }
  }
  try { watch(); paint(); } catch(e){}
  setInterval(function(){ try { watch(); paint(); } catch(e){} }, 1500);
  window.__repaintSolo = function(){ try { paint(); } catch(e){} };
})();
/* ==========================================================
   席番号（手入力）の順に、その枠の座席を並べ替えるボタン。
   常時動く監視処理は使わず、MutationObserverでボタンの列が
   再描画されたときだけ追加し直す（setIntervalに頼らないので、
   タイマーが間引かれても影響を受けない）。実際の並べ替えは
   ボタンを押した瞬間だけ動く単発処理。全角数字（１２３）も
   半角に変換してから数値として比較する。
   ========================================================== */
(function(){
  function toHalfWidth(s){
    return String(s || "").replace(/[０-９]/g, function(ch){ return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
  }
  function isNumLike(v){ return /^\s*-?\d+(\.\d+)?\s*$/.test(toHalfWidth(v)); }
  function cmp(a, b){
    var an = isNumLike(a), bn = isNumLike(b);
    if (an && bn) return parseFloat(toHalfWidth(a)) - parseFloat(toHalfWidth(b));
    if (an && !bn) return -1;
    if (!an && bn) return 1;
    return String(a || "").localeCompare(String(b || ""), "ja");
  }
  function currentDate(){
    var inp = document.querySelector("#view-seat input[type=\"date\"]");
    return inp ? inp.value : "";
  }
  function blockIndexOf(blockEl){
    var all = document.querySelectorAll("#view-seat .lesson-block"), i;
    for (i = 0; i < all.length; i++) if (all[i] === blockEl) return i;
    return -1;
  }
  function doSort(blockEl){
    var idx = blockIndexOf(blockEl);
    if (idx < 0) return;
    var date = currentDate();
    if (!date) return;
    var raw = null;
    try { raw = JSON.parse(STORAGE.getItem("seat-table-v1")); } catch(e){ return; }
    if (!raw || !raw.days || !raw.days[date]) return;
    var day = raw.days[date];
    var blocks = day.blocks || day;
    var block = blocks[idx];
    if (!block || !block.seats || !block.seats.length) return;
    var msg = "この枠の座席を、手入力した席番号の順に並べ替えます。\n" + block.seats.length + "件を対象にします。\nよろしいですか？";
    if (!window.confirm(msg)) return;
    block.seats.sort(function(a, b){ return cmp(a.seatNumber, b.seatNumber); });
    try { STORAGE.setItem("seat-table-v1", JSON.stringify(raw)); } catch(e){ return; }
    try { SESSION_STORAGE.setItem("seat-table-restore-date", date); } catch(e){}
    location.reload();
  }
  function inject(){
    var bars = document.querySelectorAll("#view-seat .block-actions"), i;
    for (i = 0; i < bars.length; i++){
      var bar = bars[i];
      if (bar.querySelector(".js-sort-by-seat")) continue;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn js-sort-by-seat";
      b.textContent = "席番号順に並べ替え";
      b.addEventListener("click", function(ev){
        var block = ev.currentTarget.closest(".lesson-block");
        if (block) doSort(block);
      });
      bar.appendChild(b);
    }
  }
  function boot(){
    try { inject(); } catch(e){}
    var target = document.querySelector("#view-seat") || document.body;
    try {
      var obs = new MutationObserver(function(){ try { inject(); } catch(e){} });
      obs.observe(target, { childList: true, subtree: true });
    } catch(e){}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else { try { boot(); } catch(e){} }
})();

/* ==========================================================
   並べ替えなどで location.reload() する前に
   sessionStorage に日付を控えておき、読み込み直し後に
   その日付へ自動で戻す。何もなければ何もしない。
   ========================================================== */
(function(){
  var KEY = "seat-table-restore-date";
  function restore(){
    var date = null;
    try { date = SESSION_STORAGE.getItem(KEY); } catch(e){ return; }
    if (!date) return;
    var inp = document.querySelector("#view-seat input[type=\"date\"]");
    if (!inp) return;
    if (inp.value === date) return;
    inp.value = date;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function cleanup(){ try { SESSION_STORAGE.removeItem(KEY); } catch(e){} }
  function boot(){
    try { restore(); } catch(e){}
    /* 他の初期化処理が後から「今日」の日付で上書きしてくることがあるため、
       少し時間を置いてからも重ねて復元を試みる。値は最後にまとめて消す。 */
    setTimeout(function(){ try { restore(); } catch(e){} }, 400);
    setTimeout(function(){ try { restore(); } catch(e){} }, 1200);
    setTimeout(function(){ try { restore(); } catch(e){} }, 3000);
    setTimeout(function(){ try { restore(); cleanup(); } catch(e){} }, 8500);
    var target = document.querySelector("#view-seat") || document.body;
    try {
      var obs = new MutationObserver(function(){ try { restore(); } catch(e){} });
      obs.observe(target, { childList: true, subtree: true });
      setTimeout(function(){ obs.disconnect(); }, 8000);
    } catch(e){}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else { try { boot(); } catch(e){} }
})();

/* ==========================================================
   枠（時間帯）ごとのQRコード共有。
   1枠ぶんのデータを配列形式に圧縮してURLに載せ、QR画像として
   表示する。読み取りはスマホの標準カメラに任せる（専用の
   読み取り機能は作らない）。QRを開くとこのアプリ自身が
   ?import= を検知して取り込み確認を出す。
   ========================================================== */
(function(){
  function toB64(str){
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fromB64(b64){
    var s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return decodeURIComponent(escape(atob(s)));
  }
  function sideOut(x){ return x ? [x.subject || "", x.grade || "", x.student || "", x.status || ""] : ["", "", "", ""]; }
  function sideIn(a){ return { subject: a[0] || "", grade: a[1] || "", student: a[2] || "", status: a[3] || "" }; }
  function compactSeats(seats){
    return (seats || []).map(function(s){
      return [s.seatNumber || "", s.teacher || "", sideOut(s.left), sideOut(s.right)];
    });
  }
  function expandSeats(arr){
    return (arr || []).map(function(t){
      return { seatNumber: t[0] || "", teacher: t[1] || "", left: sideIn(t[2] || []), right: sideIn(t[3] || []) };
    });
  }
  function compactDay(blocks){
    return (blocks || []).map(function(b){ return [b.time || "", compactSeats(b.seats)]; });
  }
  function expandDay(arr){
    return (arr || []).map(function(t){ return { time: t[0] || "", seats: expandSeats(t[1] || []) }; });
  }
  function currentDate(){
    var inp = document.querySelector("#view-seat input[type=\"date\"]");
    return inp ? inp.value : "";
  }
  function closeModal(){
    var m = document.getElementById("qrShareModal");
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }
  function showModal(url, byteLen){
    closeModal();
    var qrImg = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&ecc=L&data=" + encodeURIComponent(url);
    var wrap = document.createElement("div");
    wrap.id = "qrShareModal";
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;";
    var box = document.createElement("div");
    box.style.cssText = "background:#fff;padding:24px;border-radius:12px;max-width:360px;text-align:center;font-family:sans-serif;";
    var title = document.createElement("div");
    title.textContent = "この日のデータをQRコードで共有";
    title.style.cssText = "font-weight:bold;margin-bottom:12px;";
    var img = document.createElement("img");
    img.src = qrImg;
    img.width = 300; img.height = 300;
    img.style.cssText = "display:block;margin:0 auto;";
    var hint = document.createElement("div");
    hint.textContent = "相手のスマホの標準カメラで読み取ってもらってください。";
    hint.style.cssText = "font-size:12px;color:#666;margin-top:12px;";
    var warn = document.createElement("div");
    if (byteLen > 2500){
      warn.textContent = "データ量が多いため、模様が細かくスキャンしづらいことがあります。";
      warn.style.cssText = "font-size:12px;color:#c0392b;margin-top:6px;";
    }
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "閉じる";
    closeBtn.style.cssText = "margin-top:16px;padding:8px 20px;";
    closeBtn.addEventListener("click", closeModal);
    box.appendChild(title); box.appendChild(img); box.appendChild(hint);
    if (warn.textContent) box.appendChild(warn);
    box.appendChild(closeBtn);
    wrap.appendChild(box);
    wrap.addEventListener("click", function(ev){ if (ev.target === wrap) closeModal(); });
    document.body.appendChild(wrap);
  }
  function doShareDay(){
    var date = currentDate();
    if (!date) return;
    var raw = null;
    try { raw = JSON.parse(STORAGE.getItem("seat-table-v1")); } catch(e){ return; }
    if (!raw || !raw.days || !raw.days[date]){ window.alert("この日にはデータがありません。"); return; }
    var day = raw.days[date];
    var blocks = day.blocks || day;
    if (!blocks || !blocks.length){ window.alert("この日にはデータがありません。"); return; }
    var compact = compactDay(blocks);
    var enc = toB64(JSON.stringify(compact));
    var base = location.origin + location.pathname;
    var url = base + "?d=" + encodeURIComponent(date) + "&importDay=" + enc;
    showModal(url, url.length);
  }
  function inject(){
    var bars = document.querySelectorAll("#view-seat .js-share-actions"), i;
    for (i = 0; i < bars.length; i++){
      var bar = bars[i];
      if (bar.querySelector(".js-qr-share-day")) continue;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn js-qr-share-day";
      b.textContent = "この日をQRで共有";
      b.addEventListener("click", doShareDay);
      bar.appendChild(b);
    }
  }
  function normName(s){ return String(s || "").replace(/[\s\u3000]+/g, ""); }
  function genId(){ return Math.random().toString(36).slice(2, 9); }
  function ensureRoster(raw, blocks){
    raw.teachers = raw.teachers || [];
    raw.students = raw.students || [];
    var teacherNames = {}, studentNames = {}, i;
    for (i = 0; i < raw.teachers.length; i++) teacherNames[normName(raw.teachers[i].name)] = true;
    for (i = 0; i < raw.students.length; i++) studentNames[normName(raw.students[i].name)] = true;
    (blocks || []).forEach(function(b){
      (b.seats || []).forEach(function(seat){
        if (seat.teacher && !teacherNames[normName(seat.teacher)]){
          raw.teachers.push({ id: genId(), name: seat.teacher });
          teacherNames[normName(seat.teacher)] = true;
        }
        ["left", "right"].forEach(function(side){
          var s = seat[side];
          if (s && s.student && !studentNames[normName(s.student)]){
            raw.students.push({ id: genId(), name: s.student, grade: s.grade || "" });
            studentNames[normName(s.student)] = true;
          }
        });
      });
    });
  }
  function applyImportDay(date, blocks){
    var raw = null;
    try { raw = JSON.parse(STORAGE.getItem("seat-table-v1")) || { days: {} }; } catch(e){ raw = { days: {} }; }
    if (!raw.days) raw.days = {};
    ensureRoster(raw, blocks);
    raw.days[date] = { blocks: blocks };
    try { STORAGE.setItem("seat-table-v1", JSON.stringify(raw)); } catch(e){ return false; }
    return true;
  }
  function checkImportOnLoad(){
    var params = new URLSearchParams(location.search);
    var enc = params.get("importDay");
    if (!enc) return;
    var date = params.get("d") || "";
    if (!date){
      history.replaceState(null, "", location.pathname);
      return;
    }
    var compact = null;
    try { compact = JSON.parse(fromB64(enc)); } catch(e){
      window.alert("QRコードのデータを読み取れませんでした。");
      history.replaceState(null, "", location.pathname);
      return;
    }
    var blocks = expandDay(compact);
    var seatCount = blocks.reduce(function(a, b){ return a + (b.seats ? b.seats.length : 0); }, 0);
    var msg = date + " の全データ（" + blocks.length + "枠・" + seatCount + "席）を取り込みます。\nこの端末の" + date + "のデータは上書きされます。よろしいですか？";
    if (window.confirm(msg)){
      if (applyImportDay(date, blocks)){
        window.alert("取り込みました。");
      } else {
        window.alert("取り込みに失敗しました。");
      }
    }
    history.replaceState(null, "", location.pathname);
    location.reload();
  }
  function boot(){
    try { checkImportOnLoad(); } catch(e){}
    try { inject(); } catch(e){}
    var target = document.querySelector("#view-seat") || document.body;
    try {
      var obs = new MutationObserver(function(){ try { inject(); } catch(e){} });
      obs.observe(target, { childList: true, subtree: true });
    } catch(e){}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else { try { boot(); } catch(e){} }
})();

/* ==========================================================
   席番号の自動反映チェックボックス。
   実際の反映は handleSeatFieldChange → syncSeatNumberAcrossBlocks。
   ここではツールバーへのチェックボックス追加だけを行う。
   ========================================================== */
(function(){
  var SYNC_KEY = "seat-table-sync-enabled";
  function syncEnabled(){
    var v = null;
    try { v = STORAGE.getItem(SYNC_KEY); } catch(e){}
    return v === null ? true : v === "1";
  }
  function setSyncEnabled(on){
    try { STORAGE.setItem(SYNC_KEY, on ? "1" : "0"); } catch(e){}
  }
  function injectToggle(){
    var bars = document.querySelectorAll("#view-seat .js-seat-actions"), i;
    for (i = 0; i < bars.length; i++){
      var bar = bars[i];
      if (bar.querySelector(".js-sync-toggle-wrap")) continue;
      var wrap = document.createElement("label");
      wrap.className = "js-sync-toggle-wrap";
      wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:13px;margin-left:4px;cursor:pointer;";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = "seatNumberSyncToggle";
      cb.name = "seatNumberSync";
      cb.className = "js-sync-toggle";
      cb.checked = syncEnabled();
      cb.addEventListener("change", function(ev){
        setSyncEnabled(ev.target.checked);
      });
      var span = document.createElement("span");
      span.textContent = "番号の自動反映・並べ替え";
      wrap.appendChild(cb);
      wrap.appendChild(span);
      bar.appendChild(wrap);
    }
  }
  function boot(){
    try { injectToggle(); } catch(e){}
    var target = document.querySelector("#view-seat") || document.body;
    try {
      var obs = new MutationObserver(function(){ try { injectToggle(); } catch(e){} });
      obs.observe(target, { childList: true, subtree: true });
    } catch(e){}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else { try { boot(); } catch(e){} }
})();
/* ==========================================================
   合言葉での共有。その日全体のデータを、合言葉をキーにして
   Supabase（manabitプロジェクトに間借り）へ送受信する。
   テーブルへの直接アクセスはRLSで禁止し、
   get_seat_share / set_seat_share という関数経由でしか
   読み書きできない（合言葉を知らないと中身は見えない）。
   ========================================================== */
(function(){
  var SUPABASE_URL = "https://uglxilcwbgqoofnzngux.supabase.co";
  var SUPABASE_KEY = "sb_publishable_R83zSq90hslRd5jl04sIPg_hZlLxfRC";
  /* 校舎ごとに合言葉のキーを分ける。他校の座席表アプリと同じ
     Supabaseの表を使い回しているため、そのままだと偶然同じ
     合言葉を使うと別の校舎のデータとぶつかる可能性がある。 */
  var CODE_PREFIX = window.__seatCodePrefix || "hiiragiyama:";
  function sideOut(x){ return x ? [x.subject || "", x.grade || "", x.student || "", x.status || ""] : ["", "", "", ""]; }
  function sideIn(a){ return { subject: a[0] || "", grade: a[1] || "", student: a[2] || "", status: a[3] || "" }; }
  function compactSeats(seats){
    return (seats || []).map(function(s){
      return [s.seatNumber || "", s.teacher || "", sideOut(s.left), sideOut(s.right)];
    });
  }
  function expandSeats(arr){
    return (arr || []).map(function(t){
      return { seatNumber: t[0] || "", teacher: t[1] || "", left: sideIn(t[2] || []), right: sideIn(t[3] || []) };
    });
  }
  function compactDay(blocks){
    return (blocks || []).map(function(b){ return [b.time || "", compactSeats(b.seats)]; });
  }
  function expandDay(arr){
    return (arr || []).map(function(t){ return { time: t[0] || "", seats: expandSeats(t[1] || []) }; });
  }
  function currentDate(){
    var inp = document.querySelector("#view-seat input[type=\"date\"]");
    return inp ? inp.value : "";
  }
  async function rpc(name, params){
    var res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY },
      body: JSON.stringify(params)
    });
    if (!res.ok) throw new Error("status " + res.status);
    var text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  function normName(s){ return String(s || "").replace(/[\s\u3000]+/g, ""); }
  function genId(){ return Math.random().toString(36).slice(2, 9); }
  function ensureRoster(raw, blocks){
    raw.teachers = raw.teachers || [];
    raw.students = raw.students || [];
    var teacherNames = {}, studentNames = {}, i;
    for (i = 0; i < raw.teachers.length; i++) teacherNames[normName(raw.teachers[i].name)] = true;
    for (i = 0; i < raw.students.length; i++) studentNames[normName(raw.students[i].name)] = true;
    (blocks || []).forEach(function(b){
      (b.seats || []).forEach(function(seat){
        if (seat.teacher && !teacherNames[normName(seat.teacher)]){
          raw.teachers.push({ id: genId(), name: seat.teacher });
          teacherNames[normName(seat.teacher)] = true;
        }
        ["left", "right"].forEach(function(side){
          var s = seat[side];
          if (s && s.student && !studentNames[normName(s.student)]){
            raw.students.push({ id: genId(), name: s.student, grade: s.grade || "" });
            studentNames[normName(s.student)] = true;
          }
        });
      });
    });
  }
  function applyImportDay(date, blocks){
    var raw = null;
    try { raw = JSON.parse(STORAGE.getItem("seat-table-v1")) || { days: {} }; } catch(e){ raw = { days: {} }; }
    if (!raw.days) raw.days = {};
    ensureRoster(raw, blocks);
    raw.days[date] = { blocks: blocks };
    try { STORAGE.setItem("seat-table-v1", JSON.stringify(raw)); } catch(e){ return false; }
    return true;
  }
  async function doSend(){
    var code = window.prompt("合言葉を決めてください（相手にも伝えます）");
    if (!code) return;
    code = code.trim();
    if (!code) return;
    var date = currentDate();
    if (!date) return;
    var raw = null;
    try { raw = JSON.parse(STORAGE.getItem("seat-table-v1")); } catch(e){ return; }
    if (!raw || !raw.days || !raw.days[date]){ window.alert("この日にはデータがありません。"); return; }
    var blocks = raw.days[date].blocks || raw.days[date];
    if (!blocks || !blocks.length){ window.alert("この日にはデータがありません。"); return; }
    var payload = JSON.stringify({ date: date, blocks: compactDay(blocks) });
    try {
      await rpc("set_seat_share", { p_code: CODE_PREFIX + code, p_data: payload });
      window.alert("送信しました。合言葉「" + code + "」を相手に伝えてください。");
    } catch(e){
      window.alert("送信に失敗しました。通信環境を確認してください。");
    }
  }
  async function doReceive(){
    var code = window.prompt("合言葉を入力してください");
    if (!code) return;
    code = code.trim();
    if (!code) return;
    try {
      var rows = await rpc("get_seat_share", { p_code: CODE_PREFIX + code });
      if (!rows || !rows.length){ window.alert("その合言葉のデータは見つかりませんでした。"); return; }
      var payload = JSON.parse(rows[0].data);
      var blocks = expandDay(payload.blocks);
      var seatCount = blocks.reduce(function(a, b){ return a + (b.seats ? b.seats.length : 0); }, 0);
      var msg = payload.date + " の全データ（" + blocks.length + "枠・" + seatCount + "席）を取り込みます。\nこの端末の" + payload.date + "のデータは上書きされます。よろしいですか？";
      if (window.confirm(msg)){
        if (applyImportDay(payload.date, blocks)){
          window.alert("取り込みました。");
          location.reload();
        } else {
          window.alert("取り込みに失敗しました。");
        }
      }
    } catch(e){
      window.alert("受信に失敗しました。合言葉か通信環境を確認してください。");
    }
  }
  function inject(){
    var bars = document.querySelectorAll("#view-seat .js-share-actions"), i;
    for (i = 0; i < bars.length; i++){
      var bar = bars[i];
      if (bar.querySelector(".js-code-send")) continue;
      var sendBtn = document.createElement("button");
      sendBtn.type = "button"; sendBtn.className = "btn js-code-send"; sendBtn.textContent = "合言葉で送る";
      sendBtn.addEventListener("click", doSend);
      var recvBtn = document.createElement("button");
      recvBtn.type = "button"; recvBtn.className = "btn js-code-recv"; recvBtn.textContent = "合言葉で受け取る";
      recvBtn.addEventListener("click", doReceive);
      bar.appendChild(sendBtn);
      bar.appendChild(recvBtn);
    }
  }
  function boot(){
    try { inject(); } catch(e){}
    var target = document.querySelector("#view-seat") || document.body;
    try {
      var obs = new MutationObserver(function(){ try { inject(); } catch(e){} });
      obs.observe(target, { childList: true, subtree: true });
    } catch(e){}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else { try { boot(); } catch(e){} }
})();

/* ==========================================================
   その日の全ての枠を、まとめて席番号順に並べ替えるボタン。
   枠ごとの「席番号順に並べ替え」ボタンはそのまま残し、
   こちらは日付欄の近くに1つだけ追加する。
   ========================================================== */
(function(){
  function toHalfWidth(s){
    return String(s || "").replace(/[０-９]/g, function(ch){ return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
  }
  function isNumLike(v){ return /^\s*-?\d+(\.\d+)?\s*$/.test(toHalfWidth(v)); }
  function cmp(a, b){
    var an = isNumLike(a), bn = isNumLike(b);
    if (an && bn) return parseFloat(toHalfWidth(a)) - parseFloat(toHalfWidth(b));
    if (an && !bn) return -1;
    if (!an && bn) return 1;
    return String(a || "").localeCompare(String(b || ""), "ja");
  }
  function currentDate(){
    var inp = document.querySelector("#view-seat input[type=\"date\"]");
    return inp ? inp.value : "";
  }
  function doSortDay(){
    var date = currentDate();
    if (!date) return;
    var raw = null;
    try { raw = JSON.parse(STORAGE.getItem("seat-table-v1")); } catch(e){ return; }
    if (!raw || !raw.days || !raw.days[date]){ window.alert("この日にはデータがありません。"); return; }
    var day = raw.days[date];
    var blocks = day.blocks || day;
    if (!blocks || !blocks.length){ window.alert("この日にはデータがありません。"); return; }
    var total = blocks.reduce(function(a, b){ return a + (b.seats ? b.seats.length : 0); }, 0);
    if (!total){ window.alert("この日にはデータがありません。"); return; }
    var msg = date + " の全ての枠（" + blocks.length + "枠・" + total + "席）を、席番号順に並べ替えます。\nよろしいですか？";
    if (!window.confirm(msg)) return;
    var i;
    for (i = 0; i < blocks.length; i++){
      if (blocks[i].seats && blocks[i].seats.length){
        blocks[i].seats.sort(function(a, b){ return cmp(a.seatNumber, b.seatNumber); });
      }
    }
    try { STORAGE.setItem("seat-table-v1", JSON.stringify(raw)); } catch(e){ return; }
    try { SESSION_STORAGE.setItem("seat-table-restore-date", date); } catch(e){}
    location.reload();
  }
  function inject(){
    var bars = document.querySelectorAll("#view-seat .js-seat-actions"), i;
    for (i = 0; i < bars.length; i++){
      var bar = bars[i];
      if (bar.querySelector(".js-sort-by-seat-day")) continue;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn js-sort-by-seat-day";
      b.textContent = "この日をまとめて席番号順に並べ替え";
      b.addEventListener("click", doSortDay);
      bar.appendChild(b);
    }
  }
  function boot(){
    try { inject(); } catch(e){}
    var target = document.querySelector("#view-seat") || document.body;
    try {
      var obs = new MutationObserver(function(){ try { inject(); } catch(e){} });
      obs.observe(target, { childList: true, subtree: true });
    } catch(e){}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else { try { boot(); } catch(e){} }
})();

/* ==========================================================
   講習・振替・欠席の隣に「1対1」ボタンを追加する。
   押すと、その生徒を「1対1」として seat-table-solo に登録/解除する。
   実際の斜線描画（隣の空席への反映）は、既存の1対1機能の
   setIntervalが自動で拾って再描画してくれるので、ここでは
   マップの更新とボタン自身の見た目更新だけを行う。
   ========================================================== */
(function(){
  var KEY = "seat-table-solo";
  function norm(s){ return String(s || "").replace(/[\s\u3000]+/g, ""); }
  function load(){ try { return JSON.parse(STORAGE.getItem(KEY)) || {}; } catch(e){ return {}; } }
  function save(all){ try { STORAGE.setItem(KEY, JSON.stringify(all)); } catch(e){} }
  function currentDate(){
    var inp = document.querySelector("#view-seat input[type=\"date\"]");
    return inp ? inp.value : "";
  }
  function nameOf(cell){
    var s = cell.querySelector("select");
    if (!s || !s.value) return "";
    var o = s.options[s.selectedIndex];
    return o ? norm(o.text) : "";
  }
  function comboKey(name, subj){ return norm(name) + "\u2016" + norm(subj); }
  function subjectOf(studentCell){
    var sel = studentCell.querySelector("select");
    var side = sel ? sel.getAttribute("data-side") : null;
    var row = studentCell.closest(".seat-row-wrap");
    if (!row) return "";
    var kids = row.children;
    if (kids.length < 8) return "";
    var subjCell = side === "right" ? kids[5] : kids[2];
    var inp = subjCell.querySelector(".js-subject");
    return inp ? inp.value : "";
  }
  function isActive(cell){
    var name = nameOf(cell);
    if (!name) return false;
    var date = currentDate();
    var all = load();
    var key = comboKey(name, subjectOf(cell));
    return !!(all[date] && all[date][key]);
  }
  function toggle(cell){
    var name = nameOf(cell);
    if (!name){ window.alert("先に生徒を選択してください。"); return; }
    var date = currentDate();
    if (!date) return;
    var all = load();
    if (!all[date]) all[date] = {};
    var key = comboKey(name, subjectOf(cell));
    if (all[date][key]){
      delete all[date][key];
    } else {
      all[date][key] = 1;
    }
    save(all);
  }
  function updateButton(btn, cell){
    var active = isActive(cell);
    btn.classList.toggle("active", active);
  }
  function inject(){
    var cells = document.querySelectorAll("#view-seat .student-cell"), i;
    for (i = 0; i < cells.length; i++){
      var cell = cells[i];
      var bar = cell.querySelector(".status-buttons");
      if (!bar) continue;
      var btn = bar.querySelector(".js-solo-toggle");
      if (!btn){
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "js-solo-toggle";
        btn.textContent = "1対1";
        btn.addEventListener("click", function(ev){
          var c = ev.currentTarget.closest(".student-cell");
          if (!c) return;
          toggle(c);
          updateButton(ev.currentTarget, c);
          if (window.__repaintSolo) { try { window.__repaintSolo(); } catch(e){} }
        });
        bar.appendChild(btn);
      }
      updateButton(btn, cell);
    }
  }
  function boot(){
    try { inject(); } catch(e){}
    var target = document.querySelector("#view-seat") || document.body;
    try {
      var obs = new MutationObserver(function(){ try { inject(); } catch(e){} });
      obs.observe(target, { childList: true, subtree: true });
    } catch(e){}
    setInterval(function(){ try { inject(); } catch(e){} }, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else { try { boot(); } catch(e){} }
})();
/* ==========================================================
   「1対1」の隣に「体験授業」ボタンを追加する。
   eWebからは取り込めない完全手打ちの項目。
   その席（生徒名の入っているオブジェクト）自体に
   trial フラグを持たせて確実に紐づける。
   押すとボタンが黄色になり、生徒名欄全体（講習・振替・
   欠席と同じ見た目）も薄い黄色になる。
   ========================================================== */
(function(){
  function currentDate(){
    var inp = document.querySelector("#view-seat input[type=\"date\"]");
    return inp ? inp.value : "";
  }
  function blockIndexOf(blockEl){
    var all = document.querySelectorAll("#view-seat .lesson-block"), i;
    for (i = 0; i < all.length; i++) if (all[i] === blockEl) return i;
    return -1;
  }
  function seatIndexOf(rowEl, blockEl){
    var all = blockEl.querySelectorAll(".seat-row-wrap"), i;
    for (i = 0; i < all.length; i++) if (all[i] === rowEl) return i;
    return -1;
  }
  function locateTrial(cell){
    var sel = cell.querySelector("select");
    var side = sel ? sel.getAttribute("data-side") : null;
    var row = cell.closest(".seat-row-wrap");
    var blockEl = row ? row.closest(".lesson-block") : null;
    if (!row || !blockEl || !side) return null;
    var bIdx = blockIndexOf(blockEl);
    var sIdx = seatIndexOf(row, blockEl);
    if (bIdx < 0 || sIdx < 0) return null;
    return { bIdx: bIdx, sIdx: sIdx, side: side };
  }
  function getTrialSeatSide(loc){
    var date = currentDate();
    if (!date) return null;
    var raw = null;
    try { raw = JSON.parse(STORAGE.getItem("seat-table-v1")); } catch(e){ return null; }
    if (!raw || !raw.days || !raw.days[date]) return null;
    var blocks = raw.days[date].blocks || raw.days[date];
    var block = blocks[loc.bIdx];
    if (!block || !block.seats || !block.seats[loc.sIdx]) return null;
    var seat = block.seats[loc.sIdx];
    if (!seat[loc.side]) return null;
    return { raw: raw, date: date, seat: seat, side: loc.side };
  }
  function trialIsActive(cell){
    var loc = locateTrial(cell);
    if (!loc) return false;
    var found = getTrialSeatSide(loc);
    return !!(found && found.seat[found.side].trial);
  }
  function trialToggle(cell){
    var loc = locateTrial(cell);
    if (!loc) return;
    var found = getTrialSeatSide(loc);
    if (!found){ window.alert("先に生徒を選択してください。"); return; }
    found.seat[found.side].trial = !found.seat[found.side].trial;
    try { STORAGE.setItem("seat-table-v1", JSON.stringify(found.raw)); } catch(e){}
  }
  function updateTrialUI(btn, cell){
    var active = trialIsActive(cell);
    btn.classList.toggle("active", active);
    cell.classList.toggle("trial-active", active);
  }
  function injectTrial(){
    var cells = document.querySelectorAll("#view-seat .student-cell"), i;
    for (i = 0; i < cells.length; i++){
      var cell = cells[i];
      var bar = cell.querySelector(".status-buttons");
      if (!bar) continue;
      var btn = bar.querySelector(".js-trial-toggle");
      if (!btn){
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "js-trial-toggle";
        btn.textContent = "体験授業";
        btn.addEventListener("click", function(ev){
          var c = ev.currentTarget.closest(".student-cell");
          if (!c) return;
          trialToggle(c);
          updateTrialUI(ev.currentTarget, c);
        });
        bar.appendChild(btn);
      }
      updateTrialUI(btn, cell);
    }
  }
  function bootTrial(){
    try { injectTrial(); } catch(e){}
    var target = document.querySelector("#view-seat") || document.body;
    try {
      var obs = new MutationObserver(function(){ try { injectTrial(); } catch(e){} });
      obs.observe(target, { childList: true, subtree: true });
    } catch(e){}
    setInterval(function(){ try { injectTrial(); } catch(e){} }, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootTrial);
  else { try { bootTrial(); } catch(e){} }
})();
