import { type ComponentType } from 'react'
import Genie from './genie/Genie'
import PtEstimator from './ptEstimator/PtEstimator'

/**
 * A "tool" is a small purpose-built page you add as your work needs grow.
 * Register one here and it automatically:
 *   - appears on the Tools page,
 *   - is reachable at /tools/:id,
 *   - shows up in the ⌘K command palette.
 *
 * A tool that needs its own data adds a table to the PGlite schema + an Electric
 * shape + a FastAPI router, following the same pattern as tasks/notes.
 */
export interface Tool {
  id: string
  name: string
  description?: string
  element: ComponentType
}

export const TOOLS: Tool[] = [
  {
    id: 'pt-estimator',
    name: 'Reserved PT estimator',
    description: 'Size FMAPI reserved throughput against real usage; compare PT + PPT vs PPT-only.',
    element: PtEstimator,
  },
  {
    id: 'genie',
    name: 'Genie',
    description: 'Ask natural-language questions over your governed data via Databricks Genie One.',
    element: Genie,
  },
]
