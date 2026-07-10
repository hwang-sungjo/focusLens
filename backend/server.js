// server.js — HTTP 서버 리스닝
const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 FocusLens API Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
