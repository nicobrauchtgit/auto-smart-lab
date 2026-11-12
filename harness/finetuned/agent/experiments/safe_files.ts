/**
 * File access where a path may be swapped under the harness.
 *
 * A supervised command can write wherever its sandbox lets it. If a directory
 * the harness reads from is writable by such a command, the command can
 * replace a file there with a symlink to any host file, including one its
 * sandbox does not mount (withheld labels), and a harness that reopens the
 * path reads the target. So:
 *
 * - logs the harness reads are opened once, without following a symlink, and
 *   read through that descriptor for as long as the harness needs them;
 * - small records (status, state) are read with `O_NOFOLLOW` and must be
 *   regular files;
 * - a copy the harness hands an agent is written to a new file (`O_EXCL`,
 *   `O_NOFOLLOW`) and renamed into place, inside a directory checked
 *   component by component from a trusted base. The harness never reads such
 *   a copy back.
 *
 * Keeping authoritative files outside every writable mount is the first
 * defence; these checks are the second.
 */

import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const NOFOLLOW = constants.O_NOFOLLOW;
/** Largest record `readRecord` reads; status and state files are a few KiB. */
const RECORD_LIMIT = 16 * 1024 ** 2;

/**
 * Open (creating when absent) a log for appending and reading. Refuses a
 * symlink and anything but a regular file. The descriptor is the log from now
 * on: replacing the path later changes nothing the harness reads.
 */
export function openLog(path: string): number {
	const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK | NOFOLLOW, 0o600);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	return fd;
}

/** Open an existing regular file for reading, never through a symlink. Undefined when absent or refused. */
export function openRegular(path: string): number | undefined {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW); } catch { return undefined; }
	try {
		if (fstatSync(fd).isFile()) return fd;
	} catch { /* refused below */ }
	closeSync(fd);
	return undefined;
}

/** A small regular file's text, never through a symlink. Undefined when absent, a symlink, or too large. */
export function readRecord(path: string, limit = RECORD_LIMIT): string | undefined {
	const fd = openRegular(path);
	if (fd === undefined) return undefined;
	try {
		const size = fstatSync(fd).size;
		if (size > limit) return undefined;
		const buffer = Buffer.alloc(size);
		let count = 0;
		while (count < size) {
			const read = readSync(fd, buffer, count, size - count, count);
			if (read === 0) break;
			count += read;
		}
		return buffer.subarray(0, count).toString("utf8");
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** `readRecord` parsed as JSON; undefined when absent, refused or malformed. */
export function readRecordJson(path: string): unknown {
	const text = readRecord(path);
	if (text === undefined) return undefined;
	try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * `target` as a real directory below `base`, created where missing. Every
 * component from `base` down must currently be a directory, not a symlink.
 * This is snapshot validation, not protection against later ancestor swaps;
 * adversarial writes must use `writeCopy`, which pins directory descriptors.
 * Throws otherwise. Returns the target's canonical path.
 */
export function safeDirectory(base: string, target: string): string {
	const root = realpathSync(base);
	const rest = relative(resolve(base), resolve(target));
	if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) throw new Error(`${target} is not inside ${base}`);
	let current = root;
	for (const part of rest.split(sep).filter(Boolean)) {
		current = join(current, part);
		try { mkdirSync(current); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stat = lstatSync(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${current} is not a directory`);
	}
	return current;
}

/**
 * Copy the open file `source` to `<directory>/<name>`: a fresh file opened
 * with `O_EXCL | O_NOFOLLOW`, renamed into place (a rename replaces a symlink
 * at the destination rather than following it). Directory descriptors are
 * pinned one component at a time below the trusted base. The copy is for an
 * agent to read; the harness never reads it back.
 */
export function writeCopy(base: string, directory: string, name: string, source: number): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`unsafe copy name: ${name}`);
	// Pin each directory while traversing: lstat followed by a path open alone
	// would permit an agent to swap an ancestor between the two operations.
	const rest = relative(resolve(base), resolve(directory));
	if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) throw new Error(`${directory} is not inside ${base}`);
	let dirFd = openSync(realpathSync(base), constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
	try {
		for (const part of rest.split(sep).filter(Boolean)) {
			const child = `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${dirFd}/${part}`;
			try { mkdirSync(child); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			const next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
			closeSync(dirFd); dirFd = next;
		}
		const folder = `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${dirFd}`;
		const temporary = join(folder, `.${name}.${randomUUID()}.tmp`);
		const out = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
		try {
			const buffer = Buffer.alloc(1024 ** 2);
			const size = fstatSync(source).size;
			for (let position = 0; position < size;) {
				const read = readSync(source, buffer, 0, Math.min(buffer.length, size - position), position);
				if (read === 0) break;
				for (let written = 0; written < read;) written += writeSync(out, buffer, written, read - written);
				position += read;
			}
		} catch (error) {
			closeSync(out);
			rmSync(temporary, { force: true });
			throw error;
		}
		closeSync(out);
		const destination = join(folder, name);
		try { renameSync(temporary, destination); } catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
		return join(directory, name);
	} finally { closeSync(dirFd); }
}

/** A path with its longest existing prefix resolved. */
function canonical(path: string): string {
	const missing: string[] = [];
	for (let current = resolve(path); ;) {
		try { return join(realpathSync(current), ...missing.reverse()); } catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			missing.push(basename(current));
			current = parent;
		}
	}
}

/** Whether `inner` is `outer` or below it, both canonical. */
export function within(inner: string, outer: string): boolean {
	const delta = relative(canonical(outer), canonical(inner));
	return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}
