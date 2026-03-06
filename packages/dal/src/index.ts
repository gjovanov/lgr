// Types
export type { BaseEntity, TenantEntity, Filter, FilterOperator, FilterValue, SortSpec, PageRequest, PageResult, AggregateStage, AggregateExpression } from './types.js'

// Repository interfaces
export type { IRepository, IBatchRepository } from './repository.js'

// Registry
export type { RepositoryRegistry, RepositoryKey } from './registry.js'

// Factory
export type { DalBackend, DalConfig, CreateRepositories } from './factory.js'
export { createRepositories } from './factory.js'

// Errors
export { DalError, NotFoundError, DuplicateError, ValidationError } from './errors.js'

// Utilities
export { lookup, lookupMany } from './lookup.js'

// Entities (re-export all)
export type * from './entities/index.js'
