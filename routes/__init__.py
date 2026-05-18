"""Routes模块初始化"""
from flask import Blueprint

main_bp = Blueprint('main', __name__)

from . import main_routes
