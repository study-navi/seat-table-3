/**
 * 座席表 授業履歴（教室3専用）
 * seat-table-classroom-3 以外では使わないでください。
 * 管理情報は共通台帳へ。JSON実体はこの教室専用Driveフォルダのみ。
 */
var CLASSROOM_ID = "seat-table-classroom-3";
var LEDGER_SPREADSHEET_ID = "15X2-pTCaILM3l_OSc9zBGAuvA5uL-WBbShUMzOjtnsk";
var LEDGER_SHEET_NAME = "バックアップ台帳";
var LEDGER_HEADERS = ["教室ID", "最終バックアップ日時", "バックアップファイルID", "バックアップファイル名", "保存状態", "メモ"];

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function props_() {
  return PropertiesService.getScriptProperties();
}

function expectedToken_() {
  return String(props_().getProperty("SHARED_TOKEN") || "");
}

function assertReady_() {
  var p = props_();
  if (!p.getProperty("FOLDER_ID") || !expectedToken_()) {
    throw new Error("not_setup");
  }
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error("invalid_payload");
  return JSON.parse(e.postData.contents);
}

function authorize_(body) {
  if (!body || body.classroomId !== CLASSROOM_ID) throw new Error("classroom_mismatch");
  var token = expectedToken_();
  if (!token || body.token !== token) throw new Error("unauthorized");
}

function doGet() {
  return jsonOut_({ ok: true, classroomId: CLASSROOM_ID, postOnly: true });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    authorize_(body);
    if (body.action === "backup") return jsonOut_(handleBackup_(body, "auto"));
    if (body.action === "finalizeLesson") return jsonOut_(handleBackup_(body, "finalized"));
    if (body.action === "restore") return jsonOut_(handleRestore_());
    if (body.action === "status") return jsonOut_(handleStatus_());
    if (body.action === "history") return jsonOut_(handleHistory_());
    if (body.action === "snapshot") return jsonOut_(handleSnapshot_(body));
    return jsonOut_({ ok: false, error: "failed" });
  } catch (err) {
    var code = String(err && err.message ? err.message : "server_error");
    if (code !== "unauthorized" && code !== "classroom_mismatch" && code !== "not_setup" &&
        code !== "invalid_payload" && code !== "no_backup" && code !== "not_found") {
      code = "server_error";
    }
    return jsonOut_({ ok: false, error: code, classroomId: CLASSROOM_ID });
  }
}

function classroomFolder_() {
  return DriveApp.getFolderById(props_().getProperty("FOLDER_ID"));
}

function nowParts_() {
  var now = new Date();
  return {
    iso: now.toISOString(),
    ledger: Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss"),
    dateStamp: Utilities.formatDate(now, "Asia/Tokyo", "yyyyMMdd"),
    timeStamp: Utilities.formatDate(now, "Asia/Tokyo", "HHmmss")
  };
}

function normalizeTargetDate_(raw) {
  var s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
}

function targetDateStamp_(targetDate) {
  return String(targetDate || "").replace(/-/g, "");
}

function buildEnvelope_(data, kind, targetDate) {
  var parts = nowParts_();
  return {
    meta: {
      savedAt: parts.iso,
      kind: kind,
      targetDate: normalizeTargetDate_(targetDate),
      classroomId: CLASSROOM_ID
    },
    data: data
  };
}

function unwrapSnapshot_(parsed) {
  if (parsed && parsed.meta && parsed.data) {
    return { meta: parsed.meta, data: parsed.data };
  }
  return {
    meta: {
      savedAt: "",
      kind: "auto",
      targetDate: "",
      classroomId: CLASSROOM_ID
    },
    data: parsed
  };
}

function historyFileName_(kind, targetDate) {
  var parts = nowParts_();
  return CLASSROOM_ID + "-" + kind + "-" + targetDateStamp_(targetDate) + "-" + parts.timeStamp + ".json";
}

function isHistoryFileName_(name) {
  if (name === CLASSROOM_ID + "-latest.json") return false;
  var re = new RegExp("^" + CLASSROOM_ID + "-(auto|finalized)-\\d{8}-\\d{6}\\.json$");
  if (re.test(name)) return true;
  if (name.indexOf(CLASSROOM_ID + "-backup-") === 0 && name.slice(-5) === ".json") return true;
  return false;
}

function parseHistoryFileName_(name) {
  var m = name.match(new RegExp("^" + CLASSROOM_ID + "-(auto|finalized)-(\\d{8})-(\\d{6})\\.json$"));
  if (m) {
    var d = m[2];
    return {
      kind: m[1],
      targetDate: d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8),
      savedAt: d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) + "T" +
        m[3].slice(0, 2) + ":" + m[3].slice(2, 4) + ":" + m[3].slice(4, 6) + "+09:00"
    };
  }
  m = name.match(new RegExp("^" + CLASSROOM_ID + "-backup-(\\d{8})-(\\d{6})\\.json$"));
  if (m) {
    var d2 = m[1];
    return {
      kind: "auto",
      targetDate: "",
      savedAt: d2.slice(0, 4) + "-" + d2.slice(4, 6) + "-" + d2.slice(6, 8) + "T" +
        m[2].slice(0, 2) + ":" + m[2].slice(2, 4) + ":" + m[2].slice(4, 6) + "+09:00"
    };
  }
  return { kind: "auto", targetDate: "", savedAt: "" };
}

function updateLatestFile_(folder, jsonText) {
  var latestName = CLASSROOM_ID + "-latest.json";
  var latestId = props_().getProperty("LATEST_FILE_ID");
  var latestFile = null;
  if (latestId) {
    try { latestFile = DriveApp.getFileById(latestId); } catch (e) { latestFile = null; }
  }
  if (!latestFile) {
    var it = folder.getFilesByName(latestName);
    if (it.hasNext()) latestFile = it.next();
  }
  if (latestFile) {
    latestFile.setContent(jsonText);
    props_.setProperty("LATEST_FILE_ID", latestFile.getId());
    return latestFile;
  }
  latestFile = folder.createFile(latestName, jsonText, MimeType.PLAIN_TEXT);
  props_.setProperty("LATEST_FILE_ID", latestFile.getId());
  return latestFile;
}

function handleBackup_(body, kind) {
  assertReady_();
  if (!body.json || typeof body.json !== "object") throw new Error("invalid_payload");
  var targetDate = normalizeTargetDate_(body.targetDate);
  var envelope = buildEnvelope_(body.json, kind, targetDate);
  var jsonText = JSON.stringify(envelope);
  var folder = classroomFolder_();
  var fileName = historyFileName_(kind, targetDate);
  folder.createFile(fileName, jsonText, MimeType.PLAIN_TEXT);
  var latest = updateLatestFile_(folder, jsonText);
  var statusLabel = kind === "finalized" ? "授業完了・確定" : "自動保存";
  writeLedger_(latest.getId(), fileName, statusLabel, kind, envelope.meta.savedAt);
  return {
    ok: true,
    classroomId: CLASSROOM_ID,
    fileName: fileName,
    fileId: latest.getId(),
    kind: kind,
    targetDate: targetDate,
    updatedAt: envelope.meta.savedAt
  };
}

function handleRestore_() {
  assertReady_();
  var fileId = props_().getProperty("LATEST_FILE_ID");
  if (!fileId) throw new Error("no_backup");
  var file = DriveApp.getFileById(fileId);
  if (!fileInClassroomFolder_(file)) throw new Error("classroom_mismatch");
  var unwrapped = unwrapSnapshot_(JSON.parse(file.getBlob().getDataAsString()));
  if (unwrapped.meta.classroomId && unwrapped.meta.classroomId !== CLASSROOM_ID) {
    throw new Error("classroom_mismatch");
  }
  return {
    ok: true,
    classroomId: CLASSROOM_ID,
    json: unwrapped.data,
    meta: unwrapped.meta,
    fileName: file.getName(),
    updatedAt: file.getLastUpdated().toISOString()
  };
}

function handleSnapshot_(body) {
  assertReady_();
  var fileId = String(body.fileId || "");
  if (!fileId) throw new Error("invalid_payload");
  var file = DriveApp.getFileById(fileId);
  if (!fileInClassroomFolder_(file)) throw new Error("classroom_mismatch");
  if (!isHistoryFileName_(file.getName()) && file.getName() !== CLASSROOM_ID + "-latest.json") {
    throw new Error("not_found");
  }
  var unwrapped = unwrapSnapshot_(JSON.parse(file.getBlob().getDataAsString()));
  if (unwrapped.meta.classroomId && unwrapped.meta.classroomId !== CLASSROOM_ID) {
    throw new Error("classroom_mismatch");
  }
  var parsedName = parseHistoryFileName_(file.getName());
  return {
    ok: true,
    classroomId: CLASSROOM_ID,
    fileId: file.getId(),
    fileName: file.getName(),
    savedAt: unwrapped.meta.savedAt || parsedName.savedAt,
    kind: unwrapped.meta.kind || parsedName.kind,
    targetDate: unwrapped.meta.targetDate || parsedName.targetDate,
    json: unwrapped.data
  };
}

function handleHistory_() {
  assertReady_();
  var folder = classroomFolder_();
  var files = folder.getFiles();
  var items = [];
  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    if (!isHistoryFileName_(name)) continue;
    var parsed = parseHistoryFileName_(name);
    if (!parsed.targetDate) {
      try {
        var unwrapped = unwrapSnapshot_(JSON.parse(f.getBlob().getDataAsString()));
        if (unwrapped.meta.targetDate) parsed.targetDate = unwrapped.meta.targetDate;
        if (unwrapped.meta.kind) parsed.kind = unwrapped.meta.kind;
        if (unwrapped.meta.savedAt) parsed.savedAt = unwrapped.meta.savedAt;
      } catch (eMeta) {}
    }
    items.push({
      fileId: f.getId(),
      fileName: name,
      savedAt: parsed.savedAt || f.getLastUpdated().toISOString(),
      kind: parsed.kind,
      targetDate: parsed.targetDate
    });
  }
  items.sort(function (a, b) {
    return String(b.savedAt).localeCompare(String(a.savedAt));
  });
  return { ok: true, classroomId: CLASSROOM_ID, items: items };
}

function handleStatus_() {
  assertReady_();
  return {
    ok: true,
    classroomId: CLASSROOM_ID,
    hasBackup: !!props_().getProperty("LATEST_FILE_ID")
  };
}

function fileInClassroomFolder_(file) {
  var folderId = props_().getProperty("FOLDER_ID");
  if (!folderId) return false;
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) return true;
  }
  return false;
}

function ledgerSheet_() {
  var ss = SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(LEDGER_SHEET_NAME);
  if (!sheet) throw new Error("not_setup");
  return sheet;
}

function ensureLedgerHeaders_(sheet) {
  var row1 = sheet.getRange(1, 1, 1, 6).getValues()[0];
  if (!String(row1[0] || "").trim()) {
    sheet.getRange(1, 1, 1, 6).setValues([LEDGER_HEADERS]);
  }
}

function findClassroomRow_(sheet) {
  var last = Math.max(sheet.getLastRow(), 1);
  if (last < 2) return -1;
  var vals = sheet.getRange(2, 1, last, 1).getValues();
  var i;
  for (i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || "") === CLASSROOM_ID) return i + 2;
  }
  return -1;
}

function ensureLedgerRow_() {
  var sheet = ledgerSheet_();
  ensureLedgerHeaders_(sheet);
  var row = findClassroomRow_(sheet);
  if (row > 0) return row;
  sheet.appendRow([CLASSROOM_ID, "", "", "", "未保存", ""]);
  return sheet.getLastRow();
}

function writeLedger_(fileId, fileName, status, memo, updatedAt) {
  var sheet = ledgerSheet_();
  ensureLedgerHeaders_(sheet);
  var row = findClassroomRow_(sheet);
  if (row < 0) {
    sheet.appendRow([CLASSROOM_ID, "", "", "", "未保存", ""]);
    row = findClassroomRow_(sheet);
  }
  var current = sheet.getRange(row, 1, 1, 6).getValues()[0];
  sheet.getRange(row, 1, 1, 6).setValues([[
    CLASSROOM_ID,
    updatedAt || current[1] || "",
    fileId || current[2] || "",
    fileName || current[3] || "",
    status || "",
    memo || ""
  ]]);
}

function initialSetup() {
  if (expectedToken_() === "") {
    throw new Error("スクリプトプロパティ SHARED_TOKEN に合言葉を入れてから、もう一度 initialSetup を実行してください。");
  }
  var folderId = props_().getProperty("FOLDER_ID");
  var folder = null;
  if (folderId) {
    try { folder = DriveApp.getFolderById(folderId); } catch (e) { folder = null; }
  }
  if (!folder) {
    folder = DriveApp.createFolder("座席表バックアップ-" + CLASSROOM_ID);
    props_.setProperty("FOLDER_ID", folder.getId());
  }
  ensureLedgerRow_();
  Logger.log("セットアップ完了。教室ID: " + CLASSROOM_ID);
  Logger.log("Driveフォルダ: " + folder.getUrl());
}
