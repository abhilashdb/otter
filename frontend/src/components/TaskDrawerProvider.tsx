import { useNavigate } from 'react-router-dom'

/** Open a task's full detail page from anywhere (list/board/Overview/palette). */
export function useOpenTask() {
  const navigate = useNavigate()
  return (id: string) => navigate(`/tasks/${id}`)
}
