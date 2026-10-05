import multer from 'multer';
import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { fail } from '../validators/error.handler.js'; // adjust to wherever `fail` lives

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

const createStorage = (folder) =>
  multer.diskStorage({
    destination: async (req, file, cb) => {
      const uploadDir = path.join(__dirname, `../media/${folder}`);
      try {
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
    },
  });

// Receipts are usually a photo or a PDF. Exact matches on both mime type and extension.
const receiptFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_MIME.has(file.mimetype) && ALLOWED_EXT.has(ext)) return cb(null, true);
  cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'receipt'));
};

const receiptUpload = multer({
  storage: createStorage('receipts'),
  fileFilter: receiptFileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 5MB
});

// Same as receiptUpload.single('receipt'), but upload errors go through `fail`
// instead of falling into the generic error handler as a 500.
export const uploadReceipt = (req, res, next) => {
  receiptUpload.single('receipt')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(req, res, 413, 'File too large', 'RECEIPT_TOO_LARGE', 'Receipt too large', 'The receipt must be 5MB or smaller.');
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return fail(req, res, 400, 'Invalid receipt', 'INVALID_RECEIPT', 'Invalid receipt', 'Upload a single JPG, PNG, WEBP or PDF in the "receipt" field.');
      }
      return fail(req, res, 400, 'Upload failed', 'UPLOAD_ERROR', 'Upload failed', err.message);
    }
    next(err);
  });
};

// The file is written to disk before the handler runs, so every validation
// failure (404, 409, ...) would otherwise leave an orphaned receipt behind.
// Delete the file whenever the response ends with an error status.
export const cleanupOnError = (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400) cleanupFiles(req.file);
  });
  next();
};

export const getFileUrl = (folder, filename) => `/media/${folder}/${filename}`;

export const deleteFile = async (filePath) => {
  try {
    await fs.unlink(path.join(__dirname, '..', filePath));
    return true;
  } catch (error) {
    console.error('Error deleting file:', error);
    return false;
  }
};

// Accepts a single file object (req.file), an array, or a multer fields object
export const cleanupFiles = async (files) => {
  if (!files) return;

  let allFiles = [];
  if (Array.isArray(files)) allFiles = files;
  else if (files.path) allFiles = [files];
  else allFiles = Object.values(files).flat();

  for (const file of allFiles) {
    try {
      await fs.unlink(file.path);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Error cleaning up file:', error);
    }
  }
};