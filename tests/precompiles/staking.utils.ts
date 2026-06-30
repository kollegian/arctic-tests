/** Decode Go-style \\Uxxxxxxxx unicode escapes (as emitted by some seid string fields). */
export function decodeGoUnicodeEscapes(str: string): string {
    return str.replace(/\\U([0-9a-fA-F]{8})/g, (_, hex: string) =>
        String.fromCodePoint(parseInt(hex, 16))
    );
}
