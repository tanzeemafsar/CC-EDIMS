// =============================================================================
// EDIMS — Jenkinsfile
// Build → migrate → deploy → verify, on the Jenkins agent that hosts the app.
//
// Requirements on the agent:
//   - Linux with Docker; the Jenkins user can run `docker`.
//   - A "Secret file" credential with ID `edims-env` holding the production
//     .env (DATABASE_URL, SESSION_SECRET, ORG_NAME, ... — see .env.example).
//     The database it points at is used as-is; this pipeline never creates
//     or drops a database.
//
// The app container uses host networking, so a DATABASE_URL pointing at
// localhost reaches a Postgres running on the agent itself, and the app
// listens on PORT from the .env (default 3000) directly on the host.
// Uploads, logs and scraped hardware images live under DATA_DIR on the host
// so they survive redeploys — back up DATA_DIR/uploads with the database.
// =============================================================================

pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    triggers {
        // Fallback if no push webhook is configured: check for new commits every ~5 minutes
        pollSCM('H/5 * * * *')
    }

    parameters {
        string(name: 'DATA_DIR', defaultValue: '/opt/edims', description: 'Host folder for uploads, logs and hardware images')
        string(name: 'APP_PORT', defaultValue: '3000',       description: 'Port the app listens on (must match PORT in the .env)')
    }

    environment {
        IMAGE     = 'edims'
        CONTAINER = 'edims'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    env.TAG = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                }
                sh 'git log -1 --format="Building %h — %s (%an, %cd)"'
            }
        }

        stage('Build image') {
            steps {
                sh 'docker build --pull -t "$IMAGE:$TAG" -t "$IMAGE:latest" .'
            }
        }

        stage('Migrate database') {
            steps {
                withCredentials([file(credentialsId: 'edims-env', variable: 'EDIMS_ENV')]) {
                    // Run pending migrations from the NEW image before swapping
                    // containers, so a failing migration leaves the old app running.
                    sh 'docker run --rm --network host --env-file "$EDIMS_ENV" "$IMAGE:$TAG" node lib/migrate.js'
                }
            }
        }

        stage('Deploy') {
            steps {
                withCredentials([file(credentialsId: 'edims-env', variable: 'EDIMS_ENV')]) {
                    sh '''
                        mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/logs" "$DATA_DIR/hardware"
                        docker rm -f "$CONTAINER" 2>/dev/null || true
                        docker run -d --name "$CONTAINER" --restart unless-stopped \
                            --network host \
                            --env-file "$EDIMS_ENV" \
                            -e AUTO_MIGRATE=true \
                            -v "$DATA_DIR/uploads:/app/uploads" \
                            -v "$DATA_DIR/logs:/app/logs" \
                            -v "$DATA_DIR/hardware:/app/public/images/hardware" \
                            "$IMAGE:$TAG"
                    '''
                }
            }
        }

        stage('Verify') {
            steps {
                sh '''
                    for i in $(seq 1 30); do
                        if curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null 2>&1; then
                            echo "EDIMS $TAG is healthy on port $APP_PORT"
                            docker logs "$CONTAINER" 2>&1 | grep -E "\\[(MIGRATE|SERVER|DB)\\]" || true
                            exit 0
                        fi
                        sleep 2
                    done
                    echo "EDIMS did not become healthy within 60s — container log:"
                    docker logs --tail 100 "$CONTAINER" 2>&1
                    exit 1
                '''
            }
        }
    }

    post {
        always {
            // Keep the current and previous images; drop older EDIMS builds
            sh '''
                docker images "$IMAGE" --format "{{.Tag}}" | grep -vxE "latest|$TAG" | tail -n +2 \
                    | xargs -r -I{} docker rmi "$IMAGE:{}" || true
            '''
        }
    }
}
