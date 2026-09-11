/**
 * 座席表 Google自動バックアップ（教室3専用）
 * このファイルは seat-table-classroom-3 以外では使わないでください。
 * URLや合言葉はここに書かず、スクリプトプロパティの SHARED_TOKEN に合言葉を入れます。
 */
var CLASSROOM_ID = "seat-table-classroom-3";
var HISTORY_KEEP = 5;

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
  if (!p.getProperty("FOLDER_ID") || !p.getProperty("SPREADSHEET_ID") || !expectedToken_()) {
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

function handleBackup_(body) {
  assertReady_();
  if (!body.json || typeof body.json !== "object") throw new Error("invalid_payload");
  var jsonText = JSON.stringify(body.json);
  var p = props_();
  var folder = DriveApp.getFolderById(p.getProperty("FOLDER_ID"));
  var stamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd-HHmmss");
  var datedName = CLASSROOM_ID + "-backup-" + stamp + ".json";
  var latestName = CLASSROOM_ID + "-latest.json";

  var oldId = p.getProperty("LATEST_FILE_ID");
  if (oldId) {
    try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {}
  }
  var latest = folder.createFile(latestName, jsonText, MimeType.PLAIN_TEXT);
  p.setProperty("LATEST_FILE_ID", latest.getId());
  folder.createFile(datedName, jsonText, MimeType.PLAIN_TEXT);
  pruneHistory_(folder);

  var updatedAt = new Date().toISOString();
  writeSheet_(latest.getId(), datedName, "OK", "", updatedAt);
  return { ok: true, classroomId: CLASSROOM_ID, fileName: datedName, updatedAt: updatedAt };
}

function handleRestore_() {
  assertReady_();
  var p = props_();
  var fileId = p.getProperty("LATEST_FILE_ID");
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
  var p = props_();
  return {
    ok: true,
    classroomId: CLASSROOM_ID,
    hasBackup: !!p.getProperty("LATEST_FILE_ID")
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

function writeSheet_(fileId, fileName, result, errInfo, updatedAt) {
  var ss = SpreadsheetApp.openById(props_().getProperty("SPREADSHEET_ID"));
  var sheet = ss.getSheets()[0];
  sheet.getRange(2, 1, 1, 6).setValues([[
    CLASSROOM_ID,
    updatedAt || "",
    fileId || "",
    fileName || "",
    result || "",
    errInfo || ""
  ]]);
}

/**
 * エディタから最初に1回だけ実行する。
 * 事前にスクリプトプロパティ SHARED_TOKEN へ合言葉を入れておく。
 */
function initialSetup() {
  if (expectedToken_() === "") {
    throw new Error("スクリプトプロパティ SHARED_TOKEN に合言葉を入れてから、もう一度 initialSetup を実行してください。");
  }
  var folder = DriveApp.createFolder("座席表バックアップ-" + CLASSROOM_ID);
  var ss = SpreadsheetApp.create("座席表バックアップ管理-" + CLASSROOM_ID);
  var sheet = ss.getActiveSheet();
  sheet.setName("管理");
  sheet.getRange(1, 1, 1, 6).setValues([[
    "教室ID", "最終更新日時", "バックアップファイルID", "バックアップファイル名", "保存結果", "エラー情報"
  ]]);
  sheet.getRange(2, 1, 1, 6).setValues([[CLASSROOM_ID, "", "", "", "", "未バックアップ"]]);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  props_().setProperties({
    SPREADSHEET_ID: ss.getId(),
    FOLDER_ID: folder.getId()
  }, false);
  Logger.log("セットアップ完了。フォルダURL: " + folder.getUrl());
  Logger.log("スプレッドシートURL: " + ss.getUrl());
}
