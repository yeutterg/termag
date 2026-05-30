import winston from "winston";

const logLevel = process.env.LOG_LEVEL || "info";

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: "termag-web" },
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, service, ...metadata }) => {
          let metaStr = "";
          if (Object.keys(metadata).length > 0) {
            metaStr = JSON.stringify(metadata, null, 2);
          }
          return `${timestamp} [${service}] ${level}: ${message} ${metaStr}`;
        })
      ),
    }),
  ],
});

// If we're not in production, log to the file as well
if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
    })
  );
  logger.add(
    new winston.transports.File({
      filename: "logs/combined.log",
    })
  );
}

export default logger;
