/**
 * UTF-8 boundaries for byte-capped reads of a log.
 *
 * A cap counts bytes, and a multi-byte character can straddle it. Reading
 * forward, the cursor must stop before such a character so the next read starts
 * on it; reading the tail, a cut-off character's continuation bytes are skipped.
 * Either way no byte is silently lost and the text fits the cap.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Size of a file, or 0 when it is missing or unreadable. Never throws. */
export function fileSize(path: string): number {
	try { return statSync(path).size; } catch { return 0; }
}

/** Bytes at the end that begin a character whose remaining bytes are not in the buffer. */
export function incompleteTail(buffer: Uint8Array): number {
	for (let back = 1; back <= Math.min(4, buffer.length); back++) {
		const byte = buffer[buffer.length - back];
		if ((byte & 0xc0) === 0x80) continue;
		const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return width > back ? back : 0;
	}
	return 0;
}

/** Continuation bytes at the start, left over from a character that began before it. */
export function leadingContinuation(buffer: Uint8Array): number {
	let count = 0;
	while (count < Math.min(3, buffer.length) && (buffer[count] & 0xc0) === 0x80) count++;
	return count;
}

const decode = (buffer: Uint8Array, start: number, end: number) => Buffer.from(buffer.buffer, buffer.byteOffset + start, end - start).toString("utf8");

/**
 * The longest prefix that ends on a character boundary and, decoded, fits
 * `maxBytes`. Invalid bytes decode to U+FFFD (three bytes), so binary output
 * can need a shorter prefix than the cap. `bytes` is what the cursor advances.
 */
export function decodePrefix(buffer: Uint8Array, maxBytes: number): { text: string; bytes: number } {
	let length = buffer.length - incompleteTail(buffer);
	for (;;) {
		const text = decode(buffer, 0, length);
		const excess = Buffer.byteLength(text) - maxBytes;
		if (excess <= 0 || length === 0) return { text, bytes: length };
		length = Math.max(0, length - Math.max(1, Math.ceil(excess / 3)));
		length -= incompleteTail(buffer.subarray(0, length));
	}
}

/** The longest suffix that starts on a character boundary and, decoded, fits `maxBytes`. */
export function decodeSuffix(buffer: Uint8Array, maxBytes: number): { text: string; bytes: number } {
	let start = leadingContinuation(buffer);
	for (;;) {
		const text = decode(buffer, start, buffer.length);
		const excess = Buffer.byteLength(text) - maxBytes;
		if (excess <= 0 || start >= buffer.length) return { text, bytes: buffer.length - start };
		start = Math.min(buffer.length, start + Math.max(1, Math.ceil(excess / 3)));
		start += leadingContinuation(buffer.subarray(start));
	}
}

export function readRange(path: string, from: number, length: number): Buffer {
	const buffer = Buffer.alloc(Math.max(0, length));
	if (length <= 0) return buffer;
	const handle = openSync(path, "r");
	try {
		const count = readSync(handle, buffer, 0, length, from);
		return buffer.subarray(0, count);
	} finally {
		closeSync(handle);
	}
}

/** The end of a log within `maxBytes`, and how many earlier bytes were left out. */
export function readTail(path: string, maxBytes: number): { text: string; omittedBytes: number } {
	const size = fileSize(path);
	const length = Math.min(size, Math.max(0, maxBytes));
	if (length === 0) return { text: "", omittedBytes: size };
	const { text, bytes } = decodeSuffix(readRange(path, size - length, length), maxBytes);
	return { text, omittedBytes: size - bytes };
}
