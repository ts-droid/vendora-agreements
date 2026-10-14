// Test double: accepts a document and never answers, so the parent timeout fires.
const { parentPort } = require('worker_threads');
parentPort.on('message', function () {});
