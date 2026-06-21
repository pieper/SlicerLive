import { EventBus, type EventMap, type Listener, type Unsubscribe } from './EventBus.js';

export interface WidgetOptions {
  className?: string;
}

export abstract class Widget<State, Events extends EventMap> {
  protected host: HTMLElement;
  protected state: State;
  #bus = new EventBus<Events>();
  #disposed = false;

  constructor(host: HTMLElement, initialState: State, opts: WidgetOptions = {}) {
    this.host = host;
    this.state = initialState;
    if (opts.className) host.classList.add(opts.className);
    host.classList.add('lw-widget');
  }

  setState(patch: Partial<State>): void {
    if (this.#disposed) return;
    this.state = { ...this.state, ...patch };
    this.render();
  }

  getState(): Readonly<State> {
    return this.state;
  }

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): Unsubscribe {
    return this.#bus.on(event, fn);
  }

  protected emit<K extends keyof Events>(event: K, data: Events[K]): void {
    this.#bus.emit(event, data);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#bus.clear();
    this.onDispose();
  }

  protected abstract render(): void;
  protected onDispose(): void {}
}
