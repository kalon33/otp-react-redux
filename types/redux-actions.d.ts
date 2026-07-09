declare module 'redux-actions' {
  import { Action, AnyAction } from '@reduxjs/toolkit'

  export function createAction<T = any, P extends any[] = any[]>(
    type: string,
    ...argNames: P
  ): (...args: P) => Action

  export function createAction<T = any>(
    type: string
  ): (payload: T) => Action

  export function createAction(type: string): () => Action

  export function handleAction<T, P extends any[] = any[]>(
    actionType: string,
    reducer: (...args: P) => T,
    defaultState?: T
  ): (state: T | undefined, action: AnyAction) => T

  export function handleActions<T, P extends any[] = any[]>(
    reducers: { [key: string]: (...args: P) => T },
    defaultState?: T
  ): (state: T | undefined, action: AnyAction) => T
}
