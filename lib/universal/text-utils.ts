/**
 * Ensures content ends with a newline to prevent concatenation issues
 * when files are later appended to or processed by tools expecting proper line endings.
 * Normalizes CRLF to LF for consistent cross-platform behavior.
 *
 * @param content - The text content to normalize
 * @returns Content with CRLF normalized to LF and guaranteed trailing newline
 *
 * @example
 * ```ts
 * const text = "line1\r\nline2";
 * const normalized = ensureTrailingNewline(text);
 * // Returns: "line1\nline2\n"
 * ```
 */
export const ensureTrailingNewline = (content: string): string => {
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : normalized + "\n";
};
