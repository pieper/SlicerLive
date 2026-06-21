export type EventMap = Record<string, unknown>;
export type Listener<T> = (data: T) => void;
export type Unsubscribe = () => void;

export class EventBus<E extends EventMap> {
  #listeners = new Map<keyof E, Set<Listener<E[keyof E]>>>();

  on<K extends keyof E>(event: K, fn: Listener<E[K]>): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(fn as Listener<E[keyof E]>);
    return () => {
      set!.delete(fn as Listener<E[keyof E]>);
    };
  }

  emit<K extends keyof E>(event: K, data: E[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const fn of set) (fn as Listener<E[K]>)(data);
  }

  clear(): void {
    this.#listeners.clear();
  }
}
