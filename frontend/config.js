window.CCDI_API_BASE = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)
  ? "http://localhost:4000/api"
  : "https://digitalvote.onrender.com/api";
