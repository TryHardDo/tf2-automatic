import { Logger } from '@nestjs/common';
import fs from 'fs';
import path from 'path';
import writeFileAtomic from 'write-file-atomic';
import { LocalStorageConfig } from '../../common/config/configuration';
import { StorageEngine } from './engine.interface';

export class LocalStorageEngine implements StorageEngine {
  private readonly logger = new Logger(LocalStorageEngine.name);

  constructor(private readonly config: LocalStorageConfig) {}

  read(relativePath: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (!this.config.directory) {
        return resolve(null);
      }

      const fullPath = path.join(this.config.directory, relativePath);

      if (!fs.existsSync(fullPath)) {
        return resolve(null);
      }

      this.logger.debug(`Reading file "${fullPath}"`);

      fs.readFile(fullPath, 'utf8', (err, data) => {
        if (err) {
          this.logger.warn(`Error reading file "${fullPath}": ${err.message}`);
          return reject(err);
        }

        resolve(data);
      });
    });
  }

  write(relativePath: string, data: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.config.directory) {
        return resolve(false);
      }

      const fullPath = path.join(this.config.directory, relativePath);

      // Create directory if it doesn't exist
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.logger.debug(`Writing file to "${fullPath}"`);

      // Write to file
      writeFileAtomic(fullPath, data, (err) => {
        if (err) {
          this.logger.warn(`Error writing file "${fullPath}": ${err.message}`);
          return reject(err);
        }

        resolve(true);
      });
    });
  }
}
