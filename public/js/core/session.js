const TOKEN_KEY = 'token';
const USER_NAME_KEY = 'userName';

export function getSession() {
  return {
    token: localStorage.getItem(TOKEN_KEY) || '',
    userName: localStorage.getItem(USER_NAME_KEY) || '',
  };
}

export function saveSession(token, userName) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_NAME_KEY, userName);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_NAME_KEY);
}
