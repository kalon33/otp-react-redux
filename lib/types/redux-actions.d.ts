declare module 'redux-actions' {
  import { Action, AnyAction, Dispatch, Middleware, Reducer } from 'redux'

  interface ActionMeta<S, M> {
    meta: M
    payload: S
  }

  interface ActionPayload<S, P> {
    payload: S
    payload: P
  }

  interface ActionFunction<S, P> {
    (payload: S): ActionPayload<S, P>
    toString(): string
    type: string
  }

  interface ActionFunctionAny {
    (payload?: any): any
    toString(): string
    type: string
  }

  interface ActionFunction0<R extends Action> {
    (): R
    toString(): string
    type: string
  }

  interface ActionCreator<S, P, M, R extends Action> {
    (payload: S, meta?: M): R
    toString(): string
    type: string
  }

  function createAction<S, P = undefined, M = undefined>(
    type: string,
    payloadCreator?: (payload: S, meta?: M) => P,
    metaCreator?: (payload: S, meta?: M) => M
  ): ActionFunctionAny

  function createAction<S = undefined, P = undefined, M = undefined>(
    type: string,
    payloadCreator?: (...args: any[]) => P,
    metaCreator?: (...args: any[]) => M
  ): ActionFunctionAny

  function handleAction<E, S, P extends E, M = undefined>(
    reducer: Reducer<S, E>,
    ...handlers: Array<{
      meta?: (action: E) => M
      next?: (action: E) => S
      payload?: (action: E) => P
      throw?: (action: E, error: Error) => S
      type: string | symbol
    }>
  ): Reducer<S, E>

  function handleActions<S, E, M = undefined>(
    handlers: {
      [key: string]: (state: S, action: E & { meta?: M; payload?: any }) => S
    },
    defaultState: S
  ): Reducer<S, E>

  export { createAction, handleAction, handleActions }
}
