import { resolve } from 'node:path';
import { copyAssetsToDist } from '../../.scripts/copy-assets-to-dist.mjs';
import { duplicateDtsToCts } from '../../.scripts/duplicate-dts-to-cts.mjs';

const root = resolve('.');
duplicateDtsToCts('.');
copyAssetsToDist(root);
