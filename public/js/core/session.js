const TOKEN_KEY = 'token';
const USER_EMAIL_KEY = 'userEmail';
const LEGACY_USER_NAME_KEY = 'userName';

export function getSession() {
  return {
    token: localStorage.getItem(TOKEN_KEY) || '',
    userEmail: localStorage.getItem(USER_EMAIL_KEY) || localStorage.getItem(LEGACY_USER_NAME_KEY) || '',
  };
}

export function saveSession(token, userEmail) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_EMAIL_KEY, userEmail);
  localStorage.removeItem(LEGACY_USER_NAME_KEY);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_EMAIL_KEY);
  localStorage.removeItem(LEGACY_USER_NAME_KEY);
}
