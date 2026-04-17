#!/bin/bash
set -e

# Default to ttl.sh (an ephemeral, anonymous registry) for easiest deployment
REGISTRY=${1:-"ttl.sh"}
IMAGE_TAG=$(uuidgen | tr '[:upper:]' '[:lower:]' | head -c 8)

FRONTEND_IMAGE="${REGISTRY}/pwd-lookup-frontend-${IMAGE_TAG}:24h"
BACKEND_IMAGE="${REGISTRY}/pwd-lookup-backend-${IMAGE_TAG}:24h"

echo "Building frontend image: $FRONTEND_IMAGE"
docker build -t $FRONTEND_IMAGE -f frontend/Dockerfile.prod frontend/

echo "Building backend image: $BACKEND_IMAGE"
docker build -t $BACKEND_IMAGE -f backend/Dockerfile.prod backend/

echo "Pushing images to registry..."
docker push $FRONTEND_IMAGE
docker push $BACKEND_IMAGE

echo "Applying Kubernetes manifests..."
# Temporarily replace the image placeholders and apply
kubectl apply -f k8s/namespace.yaml

# Create a temporary directory for modified manifests
mkdir -p .k8s-tmp
cp k8s/backend.yaml .k8s-tmp/
cp k8s/frontend.yaml .k8s-tmp/

# Replace placeholders with actual image names
case "$(uname -s)" in
    Darwin*)
        sed -i "" "s|PWD_BACKEND_IMAGE|$BACKEND_IMAGE|g" .k8s-tmp/backend.yaml
        sed -i "" "s|PWD_FRONTEND_IMAGE|$FRONTEND_IMAGE|g" .k8s-tmp/frontend.yaml
        ;;
    *)
        sed -i "s|PWD_BACKEND_IMAGE|$BACKEND_IMAGE|g" .k8s-tmp/backend.yaml
        sed -i "s|PWD_FRONTEND_IMAGE|$FRONTEND_IMAGE|g" .k8s-tmp/frontend.yaml
        ;;
esac

kubectl apply -f k8s/mongodb.yaml
kubectl apply -f .k8s-tmp/backend.yaml
kubectl apply -f .k8s-tmp/frontend.yaml
kubectl apply -f k8s/ingress.yaml

# Clean up temp files
rm -rf .k8s-tmp

echo "Deployment complete! Waiting for pods to initialize..."
kubectl get pods -n pwd-lookup -w
