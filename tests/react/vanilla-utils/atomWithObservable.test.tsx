import { Component, StrictMode, Suspense, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEventOrig from '@testing-library/user-event'
import {
  BehaviorSubject,
  Observable,
  Subject,
  delay,
  interval,
  map,
  of,
  switchMap,
  take,
} from 'rxjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fromValue, makeSubject, pipe, toObservable } from 'wonka'
import { useAtom, useAtomValue, useSetAtom } from 'jotai/react'
import { atom, createStore } from 'jotai/vanilla'
import { atomWithObservable } from 'jotai/vanilla/utils'

const userEvent = {
  click: (element: Element) => act(() => userEventOrig.click(element)),
}

const consoleError = console.error
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  // A workaround for missing performance.mark after using fake timers
  // https://github.com/pmndrs/jotai/pull/1913#discussion_r1186527192
  if (!performance.mark) {
    performance.mark = (() => {}) as any
    performance.clearMarks = (() => {}) as any
    performance.clearMeasures = (() => {}) as any
  }
  // suppress error log
  console.error = vi.fn((...args: unknown[]) => {
    const message = String(args)
    if (
      message.includes('at ErrorBoundary') ||
      message.includes('Test Error')
    ) {
      return
    }
    return consoleError(...args)
  })
})

afterEach(() => {
  vi.runAllTimers()
  vi.useRealTimers()
  console.error = consoleError
})

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = {
    error: '',
  }

  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }

  render() {
    if (this.state.error) {
      return <div>Error: {this.state.error}</div>
    }
    return this.props.children
  }
}

it('count state', async () => {
  const observableAtom = atomWithObservable(() => of(1))

  const Counter = () => {
    const [state] = useAtom(observableAtom)

    return <>count: {state}</>
  }

  render(
    <StrictMode>
      <Suspense fallback="loading">
        <Counter />
      </Suspense>
    </StrictMode>,
  )

  expect(await screen.findByText('count: 1')).toBeInTheDocument()
})

it('writable count state', async () => {
  const subject = new BehaviorSubject(1)
  const observableAtom = atomWithObservable(() => subject)

  const Counter = () => {
    const [state, dispatch] = useAtom(observableAtom)
    return (
      <>
        count: {state}
        <button onClick={() => dispatch(9)}>button</button>
      </>
    )
  }

  render(
    <StrictMode>
      <Suspense fallback="loading">
        <Counter />
      </Suspense>
    </StrictMode>,
  )

  expect(await screen.findByText('count: 1')).toBeInTheDocument()

  act(() => subject.next(2))
  expect(await screen.findByText('count: 2')).toBeInTheDocument()

  await userEvent.click(screen.getByText('button'))
  expect(await screen.findByText('count: 9')).toBeInTheDocument()
  expect(subject.value).toBe(9)
})

it('writable count state without initial value', async () => {
  const subject = new Subject<number>()
  const observableAtom = atomWithObservable(() => subject)

  const CounterValue = () => {
    const state = useAtomValue(observableAtom)
    return <>count: {state}</>
  }

  const CounterButton = () => {
    const dispatch = useSetAtom(observableAtom)
    return <button onClick={() => dispatch(9)}>button</button>
  }

  await act(async () => {
    render(
      <StrictMode>
        <Suspense fallback="loading">
          <CounterValue />
        </Suspense>
        <CounterButton />
      </StrictMode>,
    )
  })

  expect(await screen.findByText('loading')).toBeInTheDocument()

  await userEvent.click(screen.getByText('button'))
  expect(await screen.findByText('count: 9')).toBeInTheDocument()

  act(() => subject.next(3))
  expect(await screen.findByText('count: 3')).toBeInTheDocument()
})

it('writable count state with delayed value', async () => {
  const subject = new Subject<number>()
  const observableAtom = atomWithObservable(() => {
    const observable = of(1).pipe(delay(10 * 1000))
    observable.subscribe((n) => subject.next(n))
    return subject
  })

  const Counter = () => {
    const [state, dispatch] = useAtom(observableAtom)
    return (
      <>
        count: {state}
        <button
          onClick={() => {
            dispatch(9)
          }}
        >
          button
        </button>
      </>
    )
  }

  await act(async () => {
    render(
      <StrictMode>
        <Suspense fallback="loading">
          <Counter />
        </Suspense>
      </StrictMode>,
    )
  })

  expect(await screen.findByText('loading')).toBeInTheDocument()
  await act(() => vi.runOnlyPendingTimers())
  expect(await screen.findByText('count: 1')).toBeInTheDocument()

  await userEvent.click(screen.getByText('button'))
  expect(await screen.findByText('count: 9')).toBeInTheDocument()
})

it('only subscribe once per atom', async () => {
  const subject = new Subject<number>()
  let totalSubscriptions = 0
  const observable = new Observable<number>((subscriber) => {
    totalSubscriptions++
    subject.subscribe(subscriber)
  })
  const observableAtom = atomWithObservable(() => observable)

  const Counter = () => {
    const [state] = useAtom(observableAtom)
    return <>count: {state}</>
  }

  let rerender: (ui: ReactNode) => void
  await act(async () => {
    ;({ rerender } = render(
      <>
        <Suspense fallback="loading">
          <Counter />
        </Suspense>
      </>,
    ))
  })

  expect(await screen.findByText('loading')).toBeInTheDocument()
  act(() => subject.next(1))
  expect(await screen.findByText('count: 1')).toBeInTheDocument()

  rerender!(<div />)
  expect(totalSubscriptions).toEqual(1)

  rerender!(
    <>
      <Suspense fallback="loading">
        <Counter />
      </Suspense>
    </>,
  )
  act(() => subject.next(2))
  expect(await screen.findByText('count: 2')).toBeInTheDocument()

  expect(totalSubscriptions).toEqual(2)
})

it('cleanup subscription', async () => {
  const subject = new Subject<number>()
  let activeSubscriptions = 0
  const observable = new Observable<number>((subscriber) => {
    activeSubscriptions++
    subject.subscribe(subscriber)
    return () => {
      activeSubscriptions--
    }
  })
  const observableAtom = atomWithObservable(() => observable)

  const Counter = () => {
    const [state] = useAtom(observableAtom)
    return <>count: {state}</>
  }

  let rerender: (ui: ReactNode) => void
  await act(async () => {
    ;({ rerender } = render(
      <StrictMode>
        <Suspense fallback="loading">
          <Counter />
        </Suspense>
      </StrictMode>,
    ))
  })

  expect(await screen.findByText('loading')).toBeInTheDocument()

  act(() => subject.next(1))
  expect(await screen.findByText('count: 1')).toBeInTheDocument()

  expect(activeSubscriptions).toEqual(1)
  rerender!(<div />)
  await waitFor(() => expect(activeSubscriptions).toEqual(0))
})

it('resubscribe on remount', async () => {
  const subject = new Subject<number>()
  const observableAtom = atomWithObservable(() => subject)

  const Counter = () => {
    const [state] = useAtom(observableAtom)
    return <>count: {state}</>
  }

  const Toggle = ({ children }: { children: ReactElement }) => {
    const [visible, setVisible] = useState(true)
    return (
      <>
        {visible && children}
        <button onClick={() => setVisible(!visible)}>Toggle</button>
      </>
    )
  }

  await act(async () => {
    render(
      <StrictMode>
        <Suspense fallback="loading">
          <Toggle>
            <Counter />
          </Toggle>
        </Suspense>
      </StrictMode>,
    )
  })

  expect(await screen.findByText('loading')).toBeInTheDocument()
  act(() => subject.next(1))
  expect(await screen.findByText('count: 1')).toBeInTheDocument()

  await userEvent.click(screen.getByText('Toggle'))
  await userEvent.click(screen.getByText('Toggle'))

  act(() => subject.next(2))
  expect(await screen.findByText('count: 2')).toBeInTheDocument()
})

it("count state with initialValue doesn't suspend", async () => {
  const subject = new Subject<number>()
  const observableAtom = atomWithObservable(() => subject, { initialValue: 5 })

  const Counter = () => {
    const [state] = useAtom(observableAtom)
    return <>count: {state}</>
  }

  render(
    <StrictMode>
      <Counter />
    </StrictMode>,
  )

  expect(await screen.findByText('count: 5')).toBeInTheDocument()

  act(() => subject.next(10))

  expect(await screen.findByText('count: 10')).toBeInTheDocument()
})

it('writable count state with initialValue', async () => {
  const subject = new Subject<number>()
  const observableAtom = atomWithObservable(() => subject, { initialValue: 5 })

  const Counter = () => {
    const [state, dispatch] = useAtom(observableAtom)
    return (
      <>
        count: {state}
        <button onClick={() => dispatch(9)}>button</button>
      </>
    )
  }

  render(
    <StrictMode>
      <Suspense fallback="loading">
        <Counter />
      </Suspense>
    </StrictMode>,
  )

  expect(await screen.findByText('count: 5')).toBeInTheDocument()
  act(() => subject.next(1))
  expect(await screen.findByText('count: 1')).toBeInTheDocument()

  await userEvent.click(screen.getByText('button'))
  expect(await screen.findByText('count: 9')).toBeInTheDocument()
})

it('writable count state with error', async () => {
  const subject = new Subject<number>()
  const observableAtom = atomWithObservable(() => subject)

  const Counter = () => {
    const [state, dispatch] = useAtom(observableAtom)
    return (
      <>
        count: {state}
        <button onClick={() => dispatch(9)}>button</button>
      </>
    )
  }

  await act(async () => {
    render(
      <StrictMode>
        <ErrorBoundary>
          <Suspense fallback="loading">
            <Counter />
          </Suspense>
        </ErrorBoundary>
      </StrictMode>,
    )
  })

  expect(await screen.findByText('loading')).toBeInTheDocument()

  act(() => subject.error(new Error('Test Error')))
  expect(await screen.findByText('Error: Test Error')).toBeInTheDocument()
})

it('synchronous subscription with initial value', async () => {
  const observableAtom = atomWithObservable(() => of(1), { initialValue: 5 })

  const Counter = () => {
    const [state] = useAtom(observableAtom)
    return <>count: {state}</>
  }

  render(
    <StrictMode>
      <Counter />
    </StrictMode>,
  )

  expect(await screen.findByText('count: 1')).toBeInTheDocument()
})

it('synchronous subscription with BehaviorSubject', async () => {
  const observableAtom = atomWithObservable(() => new BehaviorSubject(1))

  const Counter = () => {
    const [state] = useAtom(observableAtom)
    return <>count: {state}</>
  }

  render(
    <StrictMode>
      <Counter />
    </StrictMode>,
  )

  expect(await screen.findByText('count: 1')).toBeInTheDocument()
})

it('synchronous subscription with already emitted value', async () => {
  const observableAtom = atomWithObservable(() => of(1))

  const Counter = () => {
    const [state] = useAtom(observableAtom)

    return <>count: {state}</>
  }

  render(
    <StrictMode>
      <Counter />
    </StrictMode>,
  )

  expect(await screen.findByText('count: 1')).toBeInTheDocument()
})

it('with falsy initial value', async () => {
  const observableAtom = atomWithObservable(() => new Subject<number>(), {
    initialValue: 0,
  })

  const Counter = () => {
    const [state] = useAtom(observableAtom)
    return <>count: {state}</>
  }

  render(
    <StrictMode>
      <Counter />
    </StrictMode>,
  )

  expect(await screen.findByText('count: 0')).toBeInTheDocument()
})

it('with initially emitted undefined value', async () => {
  const subject = new Subject<number | undefined | null>()
  const observableAtom = atomWithObservable(() => subject)

  const Counter = () => {
    const [state] = useAtom(observableAtom)
    return <>count: {state === undefined ? '-' : state}</>
  }

  await act(async () => {
    render(
      <StrictMode>
        <Suspense fallback="loading">
          <Counter />
        </Suspense>
      </StrictMode>,
    )
  })

  expect(await screen.findByText('loading')).toBeInTheDocument()
  act(() => subject.next(undefined))
  expect(await screen.findByText('count: -')).toBeInTheDocument()
  act(() => subject.next(1))
  expect(await screen.findByText('count: 1')).toBeInTheDocument()
})

it("don't omit values emitted between init and mount", async () => {
  const subject = new Subject<number>()
  const observableAtom = atomWithObservable(() => subject)

  const Counter = () => {
    const [state, dispatch] = useAtom(observableAtom)
    return (
      <>
        count: {state}
        <button
          onClick={() => {
            dispatch(9)
          }}
        >
          button
        </button>
      </>
    )
  }

  await act(async () => {
    render(
      <StrictMode>
        <Suspense fallback="loading">
          <Counter />
        </Suspense>
      </StrictMode>,
    )
  })

  expect(await screen.findByText('loading')).toBeInTheDocument()
  act(() => {
    subject.next(1)
    subject.next(2)
  })
  expect(await screen.findByText('count: 2')).toBeInTheDocument()

  await userEvent.click(screen.getByText('button'))
  expect(await screen.findByText('count: 9')).toBeInTheDocument()
})

describe('error handling', () => {
  class ErrorBoundary extends Component<
    { message?: string; retry?: () => void; children: ReactNode },
    { hasError: boolean }
  > {
    constructor(props: { message?: string; children: ReactNode }) {
      super(props)
      this.state = { hasError: false }
    }
    static getDerivedStateFromError() {
      return { hasError: true }
    }
    render() {
      return this.state.hasError ? (
        <div>
          {this.props.message || 'errored'}
          {this.props.retry && (
            <button
              onClick={() => {
                this.props.retry?.()
                this.setState({ hasError: false })
              }}
            >
              retry
            </button>
          )}
        </div>
      ) : (
        this.props.children
      )
    }
  }

  it('can catch error in error boundary', async () => {
    const subject = new Subject<number>()
    const countAtom = atomWithObservable(() => subject)

    const Counter = () => {
      const [count] = useAtom(countAtom)
      return (
        <>
          <div>count: {count}</div>
        </>
      )
    }

    await act(async () => {
      render(
        <StrictMode>
          <ErrorBoundary>
            <Suspense fallback="loading">
              <Counter />
            </Suspense>
          </ErrorBoundary>
        </StrictMode>,
      )
    })

    expect(await screen.findByText('loading')).toBeInTheDocument()
    act(() => subject.error(new Error('Test Error')))
    expect(await screen.findByText('errored')).toBeInTheDocument()
  })

  it('can recover from error with dependency', async () => {
    const baseAtom = atom(0)
    const countAtom = atomWithObservable((get) => {
      const base = get(baseAtom)
      if (base % 2 === 0) {
        const subject = new Subject<number>()
        const observable = of(1).pipe(delay(10 * 1000))
        observable.subscribe(() => subject.error(new Error('Test Error')))
        return subject
      }
      const observable = of(base).pipe(delay(10 * 1000))
      return observable
    })

    const Counter = () => {
      const [count] = useAtom(countAtom)
      const setBase = useSetAtom(baseAtom)
      return (
        <>
          <div>count: {count}</div>
          <button onClick={() => setBase((v) => v + 1)}>next</button>
        </>
      )
    }

    const App = () => {
      const setBase = useSetAtom(baseAtom)
      const retry = () => {
        setBase((c) => c + 1)
      }
      return (
        <ErrorBoundary retry={retry}>
          <Suspense fallback="loading">
            <Counter />
          </Suspense>
        </ErrorBoundary>
      )
    }

    await act(async () => {
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
    })

    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(() => vi.runOnlyPendingTimers())
    expect(await screen.findByText('errored')).toBeInTheDocument()

    await userEvent.click(screen.getByText('retry'))
    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(() => vi.runOnlyPendingTimers())
    expect(await screen.findByText('count: 1')).toBeInTheDocument()

    await userEvent.click(screen.getByText('next'))
    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(() => vi.runOnlyPendingTimers())
    expect(await screen.findByText('errored')).toBeInTheDocument()

    await userEvent.click(screen.getByText('retry'))
    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(() => vi.runOnlyPendingTimers())
    expect(await screen.findByText('count: 3')).toBeInTheDocument()
  })

  it('can recover with intermediate atom', async () => {
    let count = -1
    let willThrowError = false
    const refreshAtom = atom(0)
    const countObservableAtom = atom((get) => {
      get(refreshAtom)
      const observableAtom = atomWithObservable(() => {
        willThrowError = !willThrowError
        ++count
        const subject = new Subject<{ data: number } | { error: Error }>()
        setTimeout(() => {
          if (willThrowError) {
            subject.next({ error: new Error('Test Error') })
          } else {
            subject.next({ data: count })
          }
        }, 10 * 1000)
        return subject
      })
      return observableAtom
    })
    const derivedAtom = atom((get) => {
      const observableAtom = get(countObservableAtom)
      const result = get(observableAtom)
      if (result instanceof Promise) {
        return result.then((result) => {
          if ('error' in result) {
            throw result.error
          }
          return result.data
        })
      }
      if ('error' in result) {
        throw result.error
      }
      return result.data
    })

    const Counter = () => {
      const [count] = useAtom(derivedAtom)
      const refresh = useSetAtom(refreshAtom)
      return (
        <>
          <div>count: {count}</div>
          <button onClick={() => refresh((c) => c + 1)}>refresh</button>
        </>
      )
    }

    const App = () => {
      const refresh = useSetAtom(refreshAtom)
      const retry = () => {
        refresh((c) => c + 1)
      }
      return (
        <ErrorBoundary retry={retry}>
          <Suspense fallback="loading">
            <Counter />
          </Suspense>
        </ErrorBoundary>
      )
    }

    await act(async () => {
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
    })

    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(() => vi.runOnlyPendingTimers())
    expect(await screen.findByText('errored')).toBeInTheDocument()

    await userEvent.click(screen.getByText('retry'))
    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(() => vi.runOnlyPendingTimers())
    expect(await screen.findByText('count: 1')).toBeInTheDocument()

    await userEvent.click(screen.getByText('refresh'))
    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(() => vi.runOnlyPendingTimers())
    expect(await screen.findByText('errored')).toBeInTheDocument()

    await userEvent.click(screen.getByText('retry'))
    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(() => vi.runOnlyPendingTimers())
    expect(await screen.findByText('count: 3')).toBeInTheDocument()
  })
})

describe('wonka', () => {
  it('count state', async () => {
    const source = fromValue(1)
    const observable = pipe(source, toObservable)
    const observableAtom = atomWithObservable(() => observable)

    const Counter = () => {
      const [count] = useAtom(observableAtom)
      return <>count: {count}</>
    }

    await act(async () => {
      render(
        <StrictMode>
          <Suspense fallback="loading">
            <Counter />
          </Suspense>
        </StrictMode>,
      )
    })

    expect(await screen.findByText('count: 1')).toBeInTheDocument()
  })

  it('make subject', async () => {
    const subject = makeSubject<number>()
    const observable = pipe(subject.source, toObservable)
    const observableAtom = atomWithObservable(() => observable)
    const countAtom = atom(
      (get) => get(observableAtom),
      (_get, _set, nextValue: number) => {
        subject.next(nextValue)
      },
    )

    const Counter = () => {
      const [count] = useAtom(countAtom)
      return <>count: {count}</>
    }

    const Controls = () => {
      const setCount = useSetAtom(countAtom)
      return <button onClick={() => setCount(1)}>button</button>
    }

    await act(async () => {
      render(
        <StrictMode>
          <Controls />
          <Suspense fallback="loading">
            <Counter />
          </Suspense>
        </StrictMode>,
      )
    })

    expect(await screen.findByText('loading')).toBeInTheDocument()

    await userEvent.click(screen.getByText('button'))
    expect(await screen.findByText('count: 1')).toBeInTheDocument()
  })
})

describe('atomWithObservable vanilla tests', () => {
  it('can propagate updates with async atom chains', async () => {
    const store = createStore()

    const subject = new BehaviorSubject(1)
    const countAtom = atomWithObservable(() => subject)
    const asyncAtom = atom(async (get) => get(countAtom))
    const async2Atom = atom((get) => get(asyncAtom))

    const unsub = store.sub(async2Atom, () => {})

    await expect(store.get(async2Atom)).resolves.toBe(1)

    subject.next(2)
    await expect(store.get(async2Atom)).resolves.toBe(2)

    subject.next(3)
    await expect(store.get(async2Atom)).resolves.toBe(3)

    unsub()
  })

  it('can propagate updates with rxjs chains', async () => {
    const store = createStore()

    const single$ = new Subject<number>()
    const double$ = single$.pipe(map((n) => n * 2))

    const singleAtom = atomWithObservable(() => single$)
    const doubleAtom = atomWithObservable(() => double$)

    const unsubs = [
      store.sub(singleAtom, () => {}),
      store.sub(doubleAtom, () => {}),
    ]

    single$.next(1)
    expect(store.get(singleAtom)).toBe(1)
    expect(store.get(doubleAtom)).toBe(2)

    single$.next(2)
    expect(store.get(singleAtom)).toBe(2)
    expect(store.get(doubleAtom)).toBe(4)

    single$.next(3)
    expect(store.get(singleAtom)).toBe(3)
    expect(store.get(doubleAtom)).toBe(6)

    unsubs.forEach((unsub) => unsub())
  })
})

it('should update continuous values in React 19', async () => {
  const counterSubject = interval(100).pipe(
    take(4),
    switchMap(async (i) => i),
  )

  const counterAtom = atomWithObservable(() => counterSubject, {
    unstable_timeout: 1000,
  })

  const countAtom = atom(async (get) => get(counterAtom))

  const Counter = () => {
    const count = useAtomValue(countAtom)
    return <div>count: {count}</div>
  }

  await act(() =>
    render(
      <StrictMode>
        <Suspense fallback="loading">
          <Counter />
        </Suspense>
      </StrictMode>,
    ),
  )

  expect(await screen.findByText('loading')).toBeInTheDocument()
  expect(await screen.findByText('count: 3')).toBeInTheDocument()
})
