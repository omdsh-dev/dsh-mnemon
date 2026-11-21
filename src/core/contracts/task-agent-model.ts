export interface TaskAgentModelCatalogModel {
  id: string
  name: string
  description?: string
  inputModalities?: string[]
}

export interface TaskAgentModelCatalogGroup {
  id: string
  name: string
  models: TaskAgentModelCatalogModel[]
}

export interface TaskAgentModelCatalogFailure {
  id: string
  name: string
  message: string
}

export interface TaskAgentModelCatalog {
  effective?: { provider: string; model: string; source: 'fixed' | 'session' | 'dsh-default' | 'active-agent' }
  defaultSelection?: { provider: string; model: string }
  session?: { provider: string; model: string }
  inherited?: { provider: string; model: string; source: 'dsh-default' | 'active-agent' }
  groups: TaskAgentModelCatalogGroup[]
  failures: TaskAgentModelCatalogFailure[]
}
