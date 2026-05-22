# Use a lightweight Node.js image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy the rest of your app code
COPY . .

# Expose port 8080 (Google Cloud Run expects this port)
ENV PORT 8080
EXPOSE 8080

# Start the server
CMD [ "npm", "start" ]