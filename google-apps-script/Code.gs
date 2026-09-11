/**
 * 座席表 Google自動バックアップ（教室3専用）
 * このファイルは seat-table-classroom-3 以外では使わないでください。
 * 管理情報は3教室共通の「バックアップ台帳」スプレッドシートへ書く。
 * 実データJSONは、この教室専用のDriveフォルダへだけ保存する（セルには入れない）。
 * URLや合言葉はここに書かず、スクリプトプロパティの SHARED_TOKEN に合言葉を入れる。
 */
var CLASSROOM_ID = "seat-table-classroom-3";
var LEDGER_SPREADSHEET_ID = "15X2-pTCaILM3l_OSc9zBGAuvA5uL-WBbShUMzOjtnsk";
var LEDGER_SHEET_NAME = "バックアップ台帳";
var HISTORY_KEEP = 5;
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
  // 疎通確認のみ。バックアップ本体は返さない。
  return jsonOut_({ ok: true, classroomId: CLASSROOM_ID, postOnly: true });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    authorize_(body);
    if (body.action === "backup") return jsonOut_(handleBackup_(body));
    if (body.action === "restore") return jsonOut_(handleRestore_());
    if (body.action === "status") return jsonOut_(handleStatus_());
    return jsonOut_({ ok: false, error: "failed" });
  } catch (err) {
    var code = String(err && err.message ? err.message : "server_error");
    if (code !== "unauthorized" && code !== "classroom_mismatch" && code !== "not_setup" && code !== "invalid_payload" && code !== "no_backup") {
      code = "server_error";
    }
    return jsonOut_({ ok: false, error: code, classroomId: CLASSROOM_ID });
  }
}

function classroomFolder_() {
  return DriveApp.getFolderById(props_().getProperty("FOLDER_ID"));
}

function handleBackup_(body) {
  assertReady_();
  if (!body.json || typeof body.json !== "object") throw new Error("invalid_payload");
  try {
    var jsonText = JSON.stringify(body.json);
    var folder = classroomFolder_();
    var stamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd-HHmmss");
    var datedName = CLASSROOM_ID + "-backup-" + stamp + ".json";
    var latestName = CLASSROOM_ID + "-latest.json";

    var oldId = props_().getProperty("LATEST_FILE_ID");
    if (oldId) {
      try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {}
    }
    var latest = folder.createFile(latestName, jsonText, MimeType.PLAIN_TEXT);
    props_().setProperty("LATEST_FILE_ID", latest.getId());
    folder.createFile(datedName, jsonText, MimeType.PLAIN_TEXT);
    pruneHistory_(folder);

    var updatedAt = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
    writeLedger_(latest.getId(), datedName, "成功", "", updatedAt);
    return { ok: true, classroomId: CLASSROOM_ID, fileName: datedName, updatedAt: new Date().toISOString() };
  } catch (err) {
    var memo = String(err && err.message ? err.message : "server_error");
    if (memo.length > 80) memo = "server_error";
    try { writeLedger_("", "", "エラー", memo, ""); } catch (e2) {}
    throw err;
  }
}

function handleRestore_() {
  assertReady_();
  var fileId = props_().getProperty("LATEST_FILE_ID");
  if (!fileId) throw new Error("no_backup");
  var file = DriveApp.getFileById(fileId);
  var parsed = JSON.parse(file.getBlob().getDataAsString());
  return {
    ok: true,
    classroomId: CLASSROOM_ID,
    json: parsed,
    fileName: file.getName(),
    updatedAt: file.getLastUpdated().toISOString()
  };
}

function handleStatus_() {
  assertReady_();
  return {
    ok: true,
    classroomId: CLASSROOM_ID,
    hasBackup: !!props_().getProperty("LATEST_FILE_ID")
  };
}

function pruneHistory_(folder) {
  var prefix = CLASSROOM_ID + "-backup-";
  var files = folder.getFiles();
  var dated = [];
  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    if (name.indexOf(prefix) === 0 && name.slice(-5) === ".json") dated.push(f);
  }
  dated.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  var i;
  for (i = HISTORY_KEEP; i < dated.length; i++) {
    dated[i].setTrashed(true);
  }
}

function ledgerSheet_() {
  var ss = SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(LEDGER_SHEET_NAME);
  if (!sheet) {
    throw new Error("not_setup");
  }
  return sheet;
}

function ensureLedgerHeaders_(sheet) {
  var row1 = sheet.getRange(1, 1, 1, 6).getValues()[0];
  var empty = !String(row1[0] || "").trim();
  if (empty) {
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
  sheet.appendRow([CLASSROOM_ID, "", "", "", "未バックアップ", ""]);
  return sheet.getLastRow();
}

/**
 * この教室の1行だけを更新する。他教室の行は触らない。JSONは書き込まない。
 */
function writeLedger_(fileId, fileName, status, memo, updatedAt) {
  var sheet = ledgerSheet_();
  ensureLedgerHeaders_(sheet);
  var row = findClassroomRow_(sheet);
  if (row < 0) {
    sheet.appendRow([CLASSROOM_ID, "", "", "", "未バックアップ", ""]);
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

/**
 * エディタから教室ごとに最初に1回実行する。
 * 事前にスクリプトプロパティ SHARED_TOKEN へ、この教室専用の合言葉を入れておく。
 * 台帳スプレッドシートは新規作成せず、既存の共通台帳を使う。
 * Driveフォルダだけ、この教室用に用意する。
 */
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
    props_().setProperty("FOLDER_ID", folder.getId());
  }
  ensureLedgerRow_();
  Logger.log("セットアップ完了。教室ID: " + CLASSROOM_ID);
  Logger.log("Driveフォルダ: " + folder.getUrl());
  Logger.log("台帳: https://docs.google.com/spreadsheets/d/" + LEDGER_SPREADSHEET_ID + "/edit");
}
