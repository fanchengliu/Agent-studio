import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
class AppBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main
        style={{
          padding: 48,
          color: '#e6ece8',
          background: '#101113',
          minHeight: '100vh',
          fontFamily: 'sans-serif',
        }}
      >
        <h1>界面遇到了问题</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>重新打开</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')).render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
