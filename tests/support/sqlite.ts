/**
 * In-memory SQLite for the integration tests. Same shape EmDash's own tests use
 * (node:sqlite behind a small Kysely-compatible wrapper). Node 22.5+ only.
 */
import { DatabaseSync } from "node:sqlite";

export class MemorySqlite {
	readonly #db = new DatabaseSync(":memory:");

	constructor() {
		this.#db.exec("PRAGMA foreign_keys = ON");
	}

	get open(): boolean {
		return this.#db.isOpen;
	}

	close(): void {
		if (this.#db.isOpen) this.#db.close();
	}

	exec(sql: string): void {
		this.#db.exec(sql);
	}

	prepare(sql: string) {
		const statement = this.#db.prepare(sql);
		const bind = (args: unknown[]) => {
			const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
			return values.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)) as never[];
		};
		return {
			reader: statement.columns().length > 0,
			all: (...args: unknown[]) => statement.all(...bind(args)),
			get: (...args: unknown[]) => statement.get(...bind(args)),
			run: (...args: unknown[]) => statement.run(...bind(args)),
			iterate: (...args: unknown[]) => statement.iterate(...bind(args)),
		};
	}
}
