import multer from 'multer';
import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { fail } from '../validators/error.handler.js'; // adjust to wherever `fail` lives

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

// Profile photos: images only (no PDF)
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const PROFILE_FOLDER = 'profiles';

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

// Exact matches on both mime type and extension.
const makeFileFilter = (mimes, exts, fieldName) => (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (mimes.has(file.mimetype) && exts.has(ext)) return cb(null, true);
  cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', fieldName));
};

const receiptUpload = multer({
  storage: createStorage('receipts'),
  fileFilter: makeFileFilter(ALLOWED_MIME, ALLOWED_EXT, 'receipt'),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 5MB
});

const profileUpload = multer({
  storage: createStorage(PROFILE_FOLDER),
  fileFilter: makeFileFilter(IMAGE_MIME, IMAGE_EXT, 'profileImage'),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 }, // 3MB
});

// Wraps a multer `.single(field)` so upload errors go through `fail`
// instead of falling into the generic error handler as a 500.
// Non-multipart requests (plain JSON) pass straight through, so the same
// route keeps working with and without a file.
const wrapSingle = (upload, field, msgs) => (req, res, next) => {
  upload.single(field)(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(req, res, 413, 'File too large', msgs.tooLarge.code, msgs.tooLarge.title, msgs.tooLarge.message);
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return fail(req, res, 400, 'Invalid file', msgs.invalid.code, msgs.invalid.title, msgs.invalid.message);
      }
      return fail(req, res, 400, 'Upload failed', 'UPLOAD_ERROR', 'Upload failed', err.message);
    }
    next(err);
  });
};

export const uploadReceipt = wrapSingle(receiptUpload, 'receipt', {
  tooLarge: { code: 'RECEIPT_TOO_LARGE', title: 'Receipt too large', message: 'The receipt must be 5MB or smaller.' },
  invalid: { code: 'INVALID_RECEIPT', title: 'Invalid receipt', message: 'Upload a single JPG, PNG, WEBP or PDF in the "receipt" field.' },
});

export const uploadProfileImage = wrapSingle(profileUpload, 'profileImage', {
  tooLarge: { code: 'PROFILE_IMAGE_TOO_LARGE', title: 'Image too large', message: 'The profile image must be 3MB or smaller.' },
  invalid: { code: 'INVALID_PROFILE_IMAGE', title: 'Invalid image', message: 'Upload a single JPG, PNG or WEBP in the "profileImage" field.' },
});

// The file is written to disk before the handler runs, so every validation
// failure (404, 409, ...) would otherwise leave an orphaned file behind.
// Delete the file whenever the response ends with an error status.
// Works for any single-file upload (receipt or profileImage) via req.file.
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
    if (error.code !== 'ENOENT') console.error('Error deleting file:', error);
    return false;
  }
};

// Deletes a stored profile image by its public URL. Refuses anything outside
// /media/profiles/ so a bad DB value can never delete an unrelated file.
export const deleteProfileImage = async (url) => {
  if (!url || !url.startsWith(`/media/${PROFILE_FOLDER}/`) || url.includes('..')) return false;
  return deleteFile(url);
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