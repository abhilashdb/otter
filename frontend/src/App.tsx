import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import AppShell from './app/AppShell'
import Overview from './routes/Overview'
import Tasks from './routes/Tasks'
import TaskDetail from './routes/TaskDetail'
import { AreaDetail, ProjectDetail } from './routes/EntityDetail'
import { ToolEmbed, ToolPage, ToolsIndex } from './routes/Tools'
import Suggestions from './routes/Suggestions'
import Settings from './routes/Settings'

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: 'overview', element: <Overview /> },
      { path: 'tasks', element: <Tasks /> },
      { path: 'tasks/:taskId', element: <TaskDetail /> },
      { path: 'areas/:areaId', element: <AreaDetail /> },
      { path: 'projects/:projectId', element: <ProjectDetail /> },
      { path: 'suggestions', element: <Suggestions /> },
      { path: 'tools', element: <ToolsIndex /> },
      { path: 'tools/ext/:extId', element: <ToolEmbed /> },
      { path: 'tools/:toolId', element: <ToolPage /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
