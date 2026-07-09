#!/bin/bash

IMAGE=ghcr.io/axelthas/devcontainer-dashboard:latest
CONTAINER_SSH_SOCKET=/tmp/ssh-agent.socket
DOCKER_SOCKET=/var/run/docker.sock

DEFAULT_WORKSPACE="$HOME/ddash-workspace"
read -r -p "Workspace directory [${DEFAULT_WORKSPACE}]: " WORKSPACE_ROOT
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$DEFAULT_WORKSPACE}"
WORKSPACE_ROOT="${WORKSPACE_ROOT/#\~/$HOME}"

mkdir -p "$WORKSPACE_ROOT"

echo "Pulling latest image..."
docker pull "$IMAGE"

docker run  --rm \
            -e HOST_HOSTNAME=$HOSTNAME \
            -e WORKSPACE_ROOT=$WORKSPACE_ROOT \
            -e SSH_AUTH_SOCK=$CONTAINER_SSH_SOCKET \
            -v $WORKSPACE_ROOT:$WORKSPACE_ROOT \
            -v $SSH_AUTH_SOCK:$CONTAINER_SSH_SOCKET \
            -v $DOCKER_SOCKET:$DOCKER_SOCKET \
            -p 3000:3000 \
            --name devcontainer-dashboard \
            $IMAGE
