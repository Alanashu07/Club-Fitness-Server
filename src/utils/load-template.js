import fs from 'fs/promises';
import path from 'path';

export async function loadTemplate(relativePath, baseDir) {
  const fullPath = path.join(baseDir, relativePath); // NOT resolve

  return fs.readFile(fullPath, 'utf-8');
}
