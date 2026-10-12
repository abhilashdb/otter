import { Link, useParams } from 'react-router-dom'
import { useLiveQuery } from '@electric-sql/pglite-react'
import { type AreaRow } from '../db/areas'
import { type ProjectRow } from '../db/projects'
import { type EntityType } from '../db/notes'
import NotesPanel from '../components/NotesPanel'
import LinksPanel from '../components/LinksPanel'

function Detail({
  entityType,
  id,
  name,
  found,
}: {
  entityType: EntityType
  id: string
  name: string
  found: boolean
}) {
  return (
    <div className="space-y-5">
      <Link to="/overview" className="text-sm text-ink-faint underline-offset-4 hover:text-ink hover:underline">
        ← Overview
      </Link>
      {!found ? (
        <p className="text-sm text-ink-faint">Not found.</p>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
          <div className="grid gap-8 border-t border-line pt-5 lg:grid-cols-[1fr_20rem]">
            <NotesPanel entityType={entityType} entityId={id} />
            <LinksPanel entityType={entityType} entityId={id} />
          </div>
        </>
      )}
    </div>
  )
}

export function AreaDetail() {
  const { areaId } = useParams()
  const id = areaId ?? ''
  const res = useLiveQuery<AreaRow>(`SELECT * FROM areas WHERE id = $1`, [id])
  const area = res?.rows?.[0]
  return <Detail entityType="area" id={id} name={area?.name ?? ''} found={!res || !!area} />
}

export function ProjectDetail() {
  const { projectId } = useParams()
  const id = projectId ?? ''
  const res = useLiveQuery<ProjectRow>(`SELECT * FROM projects WHERE id = $1`, [id])
  const project = res?.rows?.[0]
  return <Detail entityType="project" id={id} name={project?.name ?? ''} found={!res || !!project} />
}
