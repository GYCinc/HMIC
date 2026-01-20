#!/bin/bash

# Check for javac
if ! command -v javac &> /dev/null; then
    echo "Error: javac not found"
    exit 1
fi

# Check Java version (simple check for version >= 11)
# Parsing version string can be tricky, but we can check for features or major version
version=$(javac -version 2>&1 | awk -F ' ' '{print $2}')
# Remove "1." prefix if present (for Java 8 and below which are 1.8)
# For Java 9+, it is just 9, 10, 11...
major_version=$(echo "$version" | cut -d'.' -f1)
if [ "$major_version" -eq 1 ]; then
    major_version=$(echo "$version" | cut -d'.' -f2)
fi

if [ "$major_version" -lt 15 ]; then
    echo "Error: Java 15 or higher is required (found version $version). Text blocks are used."
    exit 1
fi

echo "Compiling Java Visual Layer..."
javac visual-layer/VisualLayer.java

if [ $? -eq 0 ]; then
    echo "Starting Java Visual Layer on port 2727..."
    cd visual-layer
    java VisualLayer
else
    echo "Compilation failed."
fi
