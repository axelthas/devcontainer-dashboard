#!/bin/bash

IMAGE=ghcr.io/axelthas/devcontainer-dashboard:latest
CONTAINER_SSH_SOCKET=/tmp/ssh-agent.socket
DOCKER_SOCKET=/var/run/docker.sock

DEFAULT_WORKSPACE="$HOME/ddash-workspace"
read -r -p "Workspace directory [${DEFAULT_WORKSPACE}]: " WORKSPACE_ROOT </dev/tty
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$DEFAULT_WORKSPACE}"
WORKSPACE_ROOT="${WORKSPACE_ROOT/#\~/$HOME}"

if [[ -z "${DASHBOARD_PASSWORD:-}" ]]; then
    read -r -s -p "Dashboard password: " DASHBOARD_PASSWORD </dev/tty
    printf '\n' >/dev/tty
fi
if [[ -z "$DASHBOARD_PASSWORD" ]]; then
    echo "Dashboard password must not be empty." >&2
    exit 1
fi
export DASHBOARD_PASSWORD

mkdir -p "$WORKSPACE_ROOT"

echo "Pulling latest image..."
docker pull "$IMAGE"

docker run  --rm \
            -e DASHBOARD_PASSWORD \
            -e HOST_HOSTNAME=$HOSTNAME \
            -e WORKSPACE_ROOT="$WORKSPACE_ROOT" \
            -e SSH_AUTH_SOCK=$CONTAINER_SSH_SOCKET \
            -v "$WORKSPACE_ROOT:$WORKSPACE_ROOT" \
            -v $SSH_AUTH_SOCK:$CONTAINER_SSH_SOCKET \
            -v $DOCKER_SOCKET:$DOCKER_SOCKET \
            -p 3000:3000 \
            --name devcontainer-dashboard \
            "$IMAGE" dev-bootstrap
