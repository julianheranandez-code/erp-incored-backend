'use strict';
/**
 * Document Routes — Sprint P4.3A
 */
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../middleware/auth');
const ctrl = require('../controllers/document-controller');

router.use(verifyToken);

// Types discovery
router.get('/types/:entityType', ctrl.getSupportedTypes);

// Client documents
router.post('/clients/:clientId/upload', ctrl.uploadSingle, ctrl.uploadDocument);
router.get('/clients/:clientId',         ctrl.listDocuments);

// Supplier documents
router.post('/suppliers/:supplierId/upload', ctrl.uploadSingle, ctrl.uploadDocument);
router.get('/suppliers/:supplierId',         ctrl.listDocuments);

// Shared
router.get('/download',  ctrl.getDownloadUrl);
router.delete('/',       ctrl.deleteDocument);

module.exports = router;
