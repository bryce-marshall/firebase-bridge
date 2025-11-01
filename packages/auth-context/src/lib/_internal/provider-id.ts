import { AutoProvider } from '../types.js';
import {
    alphanumericId,
    base64LikeId,
    hexId,
    numericId,
    userId,
} from './util.js';

export function providerId(type: AutoProvider | string): string {
  switch (type) {
    case 'google':
    case 'google.com':
      return numericId(21);

    case 'apple':
    case 'apple.com':
      return `${numericId(6)}.${hexId(32)}.${numericId(4)}`;

    case 'facebook':
    case 'facebook.com':
      return numericId(17);

    case 'twitter':
    case 'twitter.com':
      return numericId(18);

    case 'github':
    case 'github.com':
      return numericId(10);

    case 'microsoft':
    case 'microsoft.com':
      return hexId(32);

    case 'yahoo':
    case 'yahoo.com':
      return alphanumericId(26, 'upper');

    case 'playgames':
    case 'playgames.google.com':
      return base64LikeId(20);

    case 'gamecenter':
    case 'gc.apple.com':
      return `G:${numericId(10)}`;

    case 'phone':
      return `+1555${numericId(7)}`;

    default:
      return userId();
  }
}
