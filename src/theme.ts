import { createTheme } from '@mui/material/styles';

const shared = {
  typography: {
    fontFamily: '"JetBrains Mono", "Fira Code", "IBM Plex Mono", monospace',
    h1: { fontFamily: '"Space Grotesk", "Plus Jakarta Sans", sans-serif', fontWeight: 700 },
    h2: { fontFamily: '"Space Grotesk", "Plus Jakarta Sans", sans-serif', fontWeight: 600 },
    h3: { fontFamily: '"Space Grotesk", "Plus Jakarta Sans", sans-serif', fontWeight: 600 },
    h4: { fontFamily: '"Space Grotesk", "Plus Jakarta Sans", sans-serif', fontWeight: 600 },
    h5: { fontFamily: '"Space Grotesk", "Plus Jakarta Sans", sans-serif', fontWeight: 500 },
    h6: { fontFamily: '"Space Grotesk", "Plus Jakarta Sans", sans-serif', fontWeight: 500 },
    button: { textTransform: 'none' as const, fontWeight: 600 },
  },
  shape: { borderRadius: 12 },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 8, padding: '12px 24px', fontSize: '1rem' },
        contained: {
          boxShadow: '0 4px 14px 0 rgba(0, 209, 255, 0.3)',
          '&:hover': { boxShadow: '0 6px 20px 0 rgba(0, 209, 255, 0.4)' },
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 8,
            '& fieldset': { borderColor: 'rgba(139, 157, 195, 0.3)' },
            '&:hover fieldset': { borderColor: 'rgba(0, 209, 255, 0.5)' },
            '&.Mui-focused fieldset': { borderColor: '#00D1FF' },
          },
        },
      },
    },
    MuiSelect: {
      styleOverrides: { root: { borderRadius: 8 } },
    },
    MuiCheckbox: {
      styleOverrides: {
        root: { color: 'rgba(139, 157, 195, 0.5)', '&.Mui-checked': { color: '#00D1FF' } },
      },
    },
  },
};

export const darkTheme = createTheme({
  ...shared,
  palette: {
    mode: 'dark',
    primary: { main: '#00D1FF', light: '#5CE1FF', dark: '#00A3CC' },
    secondary: { main: '#FF6B35', light: '#FF8F66', dark: '#CC5629' },
    background: { default: '#0A0E17', paper: '#131A2A' },
    text: { primary: '#E8EDF5', secondary: '#8B9DC3' },
    success: { main: '#22C55E' },
    error: { main: '#EF4444' },
  },
  components: {
    ...shared.components,
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            ...shared.components.MuiTextField.styleOverrides.root['& .MuiOutlinedInput-root'],
            backgroundColor: 'rgba(19, 26, 42, 0.8)',
          },
        },
      },
    },
    MuiSelect: {
      styleOverrides: { root: { borderRadius: 8, backgroundColor: 'rgba(19, 26, 42, 0.8)' } },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: 'rgba(19, 26, 42, 0.95)',
          backdropFilter: 'blur(20px)',
        },
      },
    },
  },
});

export const lightTheme = createTheme({
  ...shared,
  palette: {
    mode: 'light',
    primary: { main: '#0088AA', light: '#00B8E6', dark: '#006680' },
    secondary: { main: '#E05A2B', light: '#FF7A4D', dark: '#B04520' },
    background: { default: '#F5F7FA', paper: '#FFFFFF' },
    text: { primary: '#1A2332', secondary: '#5A6A85' },
    success: { main: '#16A34A' },
    error: { main: '#DC2626' },
  },
  components: {
    ...shared.components,
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            ...shared.components.MuiTextField.styleOverrides.root['& .MuiOutlinedInput-root'],
            backgroundColor: 'rgba(245, 247, 250, 0.8)',
          },
        },
      },
    },
    MuiSelect: {
      styleOverrides: { root: { borderRadius: 8, backgroundColor: 'rgba(245, 247, 250, 0.8)' } },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: '#FFFFFF',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
        },
      },
    },
  },
});

// Keep backward compat
export const theme = darkTheme;
