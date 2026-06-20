import { Pipe, type PipeTransform } from '@angular/core';

/**
 * Renders internal underscore-separated media names with spaces.
 *
 * Internal storage uses underscores (e.g. `File_Name_Video`) for compatibility
 * with safe-name regexes that disallow spaces. This pipe transforms the
 * stored value into a human-readable form for UI display:
 *
 * - Multiple consecutive underscores collapse to a single space.
 * - Leading/trailing underscores are trimmed (storage layer prevents these,
 *   but legacy data could still contain them).
 * - The result is trimmed of surrounding whitespace.
 *
 * Examples:
 *   `File_Name_Video`     -> `File Name Video`
 *   `File__Name`          -> `File Name`
 *   `_File_Name_`         -> `File Name`
 *   `null` / `undefined`  -> `''`
 */
@Pipe({
  name: 'displayName',
  standalone: true
})
export class DisplayNamePipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) {
      return '';
    }

    return value
      .replace(/_+/g, ' ')
      .trim();
  }
}