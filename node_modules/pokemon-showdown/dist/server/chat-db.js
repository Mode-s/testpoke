"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var chat_db_exports = {};
__export(chat_db_exports, {
  pluginDatabase: () => pluginDatabase
});
module.exports = __toCommonJS(chat_db_exports);
var ConfigLoader = __toESM(require("./config-loader"));
var import_lib = require("../lib");
const PLUGIN_DATABASE_PATH = "./databases/chat-plugins.db";
const pluginDatabase = (0, import_lib.SQL)("chat-db", module, {
  file: global.Config?.nofswriting ? ":memory:" : PLUGIN_DATABASE_PATH
});
if (!pluginDatabase.isParentProcess) {
  ConfigLoader.ensureLoaded();
  global.Monitor = {
    crashlog(error, source = "A chat child process", details = null) {
      const repr = JSON.stringify([error.name, error.message, source, details]);
      process.send(`THROW
@!!@${repr}
${error.stack}`);
    }
  };
  process.on("uncaughtException", (err) => {
    Monitor.crashlog(err, "A chat database process");
  });
  process.on("unhandledRejection", (err) => {
    Monitor.crashlog(err, "A chat database process");
  });
  pluginDatabase.startRepl((cmd) => eval(cmd));
}
//# sourceMappingURL=chat-db.js.map
