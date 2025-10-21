"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IpcProxyError = void 0;
exports.isFunction = isFunction;
exports.getSubscriptionKey = getSubscriptionKey;
const serialize_error_1 = require("serialize-error");
/* Custom Error */
class IpcProxyError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}
exports.IpcProxyError = IpcProxyError;
(0, serialize_error_1.addKnownErrorConstructor)(IpcProxyError);
/* Utils */
// eslint-disable-next-line @typescript-eslint/ban-types
function isFunction(value) {
    return value !== undefined && typeof value === 'function';
}
/**
 * Fix ContextIsolation
 * @param key original key
 * @returns
 */
function getSubscriptionKey(key) {
    return `${key}Subscribe`;
}
