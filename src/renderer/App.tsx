import { ThemeProvider } from './components/ThemeProvider'
import { AppLayout } from './components/layout/AppLayout'
import { TextSelectionMenu } from './components/text-menu/TextSelectionMenu'

function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <AppLayout />
      <TextSelectionMenu />
    </ThemeProvider>
  )
}

export default App
