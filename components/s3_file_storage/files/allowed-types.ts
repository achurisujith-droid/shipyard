/**
 * Which files your product accepts, and how big.
 *
 * This file is yours to edit — it is the one thing about file uploads that is a
 * product decision rather than a security one. The code that uses it is not.
 *
 * One warning worth keeping: adding `text/html` or `image/svg+xml` means people
 * can upload something that runs script when it is opened. If you need either,
 * serve them from a different domain than your app.
 */

export const ALLOWED_TYPES: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'application/pdf': ['.pdf'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

export const MAX_BYTES = 25 * 1024 * 1024;
