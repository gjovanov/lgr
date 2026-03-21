import { logger } from '../logger/logger.js'

// ── Types ──

export interface StateTransition<S extends string> {
  from: S | S[]
  to: S
  guard?: (entity: any) => boolean | Promise<boolean>
}

export interface StateMachineConfig<S extends string> {
  name: string // e.g., 'SalesOrder', 'PurchaseOrder'
  states: readonly S[]
  initial: S
  transitions: Record<string, StateTransition<S>>
  hooks?: {
    onEnter?: Partial<Record<S, (entity: any) => Promise<void>>>
    onExit?: Partial<Record<S, (entity: any) => Promise<void>>>
  }
}

export class StateMachineError extends Error {
  constructor(
    public readonly machineName: string,
    public readonly action: string,
    public readonly currentState: string,
    message: string,
  ) {
    super(message)
    this.name = 'StateMachineError'
  }
}

// ── State Machine ──

export class StateMachine<S extends string> {
  constructor(private config: StateMachineConfig<S>) {}

  get initialState(): S {
    return this.config.initial
  }

  /**
   * Check if a transition is allowed from the current state.
   */
  canTransition(currentState: S, action: string): boolean {
    const transition = this.config.transitions[action]
    if (!transition) return false
    const fromStates = Array.isArray(transition.from) ? transition.from : [transition.from]
    return fromStates.includes(currentState)
  }

  /**
   * Get the target state for an action from a given state, or null if not allowed.
   */
  getTargetState(currentState: S, action: string): S | null {
    if (!this.canTransition(currentState, action)) return null
    return this.config.transitions[action].to
  }

  /**
   * Get all actions available from a given state.
   */
  availableActions(currentState: S): string[] {
    return Object.entries(this.config.transitions)
      .filter(([, transition]) => {
        const fromStates = Array.isArray(transition.from) ? transition.from : [transition.from]
        return fromStates.includes(currentState)
      })
      .map(([action]) => action)
  }

  /**
   * Execute a state transition. Returns the new state.
   * Throws StateMachineError if the transition is invalid or guard fails.
   */
  async transition(entity: { state: S; [key: string]: any }, action: string): Promise<S> {
    const transition = this.config.transitions[action]
    if (!transition) {
      throw new StateMachineError(
        this.config.name,
        action,
        entity.state,
        `Unknown action "${action}" on ${this.config.name}`,
      )
    }

    const fromStates = Array.isArray(transition.from) ? transition.from : [transition.from]
    if (!fromStates.includes(entity.state)) {
      throw new StateMachineError(
        this.config.name,
        action,
        entity.state,
        `Cannot "${action}" ${this.config.name} in state "${entity.state}" (allowed from: ${fromStates.join(', ')})`,
      )
    }

    // Run guard
    if (transition.guard) {
      const allowed = await transition.guard(entity)
      if (!allowed) {
        throw new StateMachineError(
          this.config.name,
          action,
          entity.state,
          `Guard rejected "${action}" on ${this.config.name} in state "${entity.state}"`,
        )
      }
    }

    const oldState = entity.state
    const newState = transition.to

    // Exit hook
    const onExit = this.config.hooks?.onExit?.[oldState]
    if (onExit) await onExit(entity)

    // Enter hook
    const onEnter = this.config.hooks?.onEnter?.[newState]
    if (onEnter) await onEnter(entity)

    logger.info(
      { machine: this.config.name, action, from: oldState, to: newState },
      `${this.config.name}: ${oldState} → ${newState} (${action})`,
    )

    return newState
  }
}
