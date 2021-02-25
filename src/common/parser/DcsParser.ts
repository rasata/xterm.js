/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IDisposable } from 'common/Types';
import { IDcsHandler, IParams, IHandlerCollection, IDcsParser, DcsFallbackHandlerType } from 'common/parser/Types';
import { utf32ToString } from 'common/input/TextDecoder';
import { Params } from 'common/parser/Params';
import { PAYLOAD_LIMIT } from 'common/parser/Constants';

const EMPTY_HANDLERS: IDcsHandler[] = [];

export class DcsParser implements IDcsParser {
  private _handlers: IHandlerCollection<IDcsHandler> = Object.create(null);
  private _active: IDcsHandler[] = EMPTY_HANDLERS;
  private _ident: number = 0;
  private _handlerFb: DcsFallbackHandlerType = () => { };

  public dispose(): void {
    this._handlers = Object.create(null);
    this._handlerFb = () => { };
    this._active = EMPTY_HANDLERS;
  }

  public registerHandler(ident: number, handler: IDcsHandler): IDisposable {
    if (this._handlers[ident] === undefined) {
      this._handlers[ident] = [];
    }
    const handlerList = this._handlers[ident];
    handlerList.push(handler);
    return {
      dispose: () => {
        const handlerIndex = handlerList.indexOf(handler);
        if (handlerIndex !== -1) {
          handlerList.splice(handlerIndex, 1);
        }
      }
    };
  }

  public clearHandler(ident: number): void {
    if (this._handlers[ident]) delete this._handlers[ident];
  }

  public setHandlerFallback(handler: DcsFallbackHandlerType): void {
    this._handlerFb = handler;
  }

  public reset(): void {
    // force cleanup leftover handlers
    if (this._active.length) {
      for (let j = this._stack.paused ? this._stack.loopPosition - 1 : this._active.length - 1; j >= 0; --j) {
        this._active[j].unhook(false);
      }
    }
    this._stack.paused = false;
    this._active = EMPTY_HANDLERS;
    this._ident = 0;
  }

  public hook(ident: number, params: IParams): void {
    // always reset leftover handlers
    this.reset();
    this._ident = ident;
    this._active = this._handlers[ident] || EMPTY_HANDLERS;
    if (!this._active.length) {
      this._handlerFb(this._ident, 'HOOK', params);
    } else {
      for (let j = this._active.length - 1; j >= 0; j--) {
        this._active[j].hook(params);
      }
    }
  }

  public put(data: Uint32Array, start: number, end: number): void {
    if (!this._active.length) {
      this._handlerFb(this._ident, 'PUT', utf32ToString(data, start, end));
    } else {
      for (let j = this._active.length - 1; j >= 0; j--) {
        this._active[j].put(data, start, end);
      }
    }
  }

  private _stack = {
    paused: false,
    loopPosition: 0,
    fallThrough: false
  };
  public unhook(success: boolean, promiseResult?: boolean): void | Promise<boolean> {
    if (!this._active.length) {
      this._handlerFb(this._ident, 'UNHOOK', success);
    } else {
      let handlerResult: any = false;
      let j = this._active.length - 1;
      let fallThrough = false;
      if (this._stack.paused) {
        j = this._stack.loopPosition - 1;
        handlerResult = promiseResult;
        fallThrough = this._stack.fallThrough;
        this._stack.paused = false;
      }
      if (!fallThrough && handlerResult === false) {
        for (; j >= 0; j--) {
          if ((handlerResult = this._active[j].unhook(success)) !== false) {
            if (handlerResult instanceof Promise) {
              this._stack.paused = true;
              this._stack.loopPosition = j;
              this._stack.fallThrough = false;
              return handlerResult;
            }
            break;
          }
        }
        j--;
      }
      // cleanup left over handlers (fallThrough for async)
      for (; j >= 0; j--) {
        if ((handlerResult = this._active[j].unhook(false)) instanceof Promise) {
          this._stack.paused = true;
          this._stack.loopPosition = j;
          this._stack.fallThrough = true;
          return handlerResult;
        }
      }
    }
    this._active = EMPTY_HANDLERS;
    this._ident = 0;
  }
}

// predefine empty params as [0] (ZDM)
const EMPTY_PARAMS = new Params();
EMPTY_PARAMS.addParam(0);

/**
 * Convenient class to create a DCS handler from a single callback function.
 * Note: The payload is currently limited to 50 MB (hardcoded).
 */
export class DcsHandler implements IDcsHandler {
  private _data = '';
  private _params: IParams = EMPTY_PARAMS;
  private _hitLimit: boolean = false;

  constructor(private _handler: (data: string, params: IParams) => boolean | Promise<boolean>) { }

  public hook(params: IParams): void {
    // since we need to preserve params until `unhook`, we have to clone it
    // (only borrowed from parser and spans multiple parser states)
    // perf optimization:
    // clone only, if we have non empty params, otherwise stick with default
    this._params = (params.length > 1 || params.params[0]) ? params.clone() : EMPTY_PARAMS;
    this._data = '';
    this._hitLimit = false;
  }

  public put(data: Uint32Array, start: number, end: number): void {
    if (this._hitLimit) {
      return;
    }
    this._data += utf32ToString(data, start, end);
    if (this._data.length > PAYLOAD_LIMIT) {
      this._data = '';
      this._hitLimit = true;
    }
  }

  public unhook(success: boolean): boolean | Promise<boolean> {
    let ret: boolean | Promise<boolean> = false;
    if (this._hitLimit) {
      ret = false;
    } else if (success) {
      if ((ret = this._handler(this._data, this._params)) instanceof Promise) {
        // FIXME: should this be behind a catch rule?
        return ret.then(res => {
          // cleanup handler state late
          this._params = EMPTY_PARAMS;
          this._data = '';
          this._hitLimit = false;
          return res;
        });
      }
    }
    this._params = EMPTY_PARAMS;
    this._data = '';
    this._hitLimit = false;
    return ret;
  }
}
