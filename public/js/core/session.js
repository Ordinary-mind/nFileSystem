const TOKEN_KEY = 'token';
const USER_EMAIL_KEY = 'userEmail';

export function getSession() {
  return {
    token: localStorage.getItem(TOKEN_KEY) || '',
    userEmail: localStorage.getItem(USER_EMAIL_KEY) || '',
  };
}

export function saveSession(token, userEmail) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_EMAIL_KEY, userEmail);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_EMAIL_KEY);
}
