interface ExpectedWriteState {
  accepted?: string;
  pending: string[];
}

export class ExpectedTextFileWrites {
  readonly #writes = new Map<string, ExpectedWriteState>();

  add(file: string, source: string): void {
    const state = this.#writes.get(file) ?? { pending: [] };
    if (state.accepted === source || state.pending.at(-1) === source) return;
    state.pending.push(source);
    this.#writes.set(file, state);
  }

  has(file: string): boolean {
    return this.#writes.has(file);
  }

  match(file: string, source: string): boolean {
    const state = this.#writes.get(file);
    if (!state) return false;
    if (state.accepted === source) return true;
    const match = state.pending.indexOf(source);
    if (match < 0) {
      this.#writes.delete(file);
      return false;
    }
    state.accepted = source;
    state.pending = state.pending.slice(match + 1);
    return true;
  }

  discard(file: string): void {
    this.#writes.delete(file);
  }
}
