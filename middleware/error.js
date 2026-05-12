const errorHandler = (err, req, res, next) => {
  console.error("Error:", err);

  let statusCode = err.statusCode || res.statusCode === 200 ? 500 : res.statusCode;
  let message = err.message || "Internal Server Error";

  if (err.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(", ");
  }

  if (err.code === 11000) {
    statusCode = 400;
    const field = Object.keys(err.keyValue || {})[0] || "field";
    message = `Duplicate ${field} value`;
  }

  if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    message = "Invalid token";
  }

  res.status(statusCode || 500).json({
    success: false,
    message,
    stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
  });
};

module.exports = errorHandler;
